use std::{
    cell::RefCell,
    collections::{BTreeMap, btree_map},
    future::Future,
    sync::Arc,
    task::{Context, Poll, Waker},
};

use nanocode_board::{Board, BoardError, Change, Entry, Fold, Op, Phase, Rejection};
use nanocode_durability_core::{Sql, SqlRow, SqlStatement, StoreError, StoreFuture};
use nanocode_turnlog::SqlLog;
use serde::Deserialize;
use serde_json::{Value, json};

#[link(wasm_import_module = "host")]
unsafe extern "C" {
    fn sql(ptr: *const u8, len: usize) -> u64;
}

struct Host;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Answer {
    Rows(Vec<Vec<SqlRow>>),
    Error(String),
}

impl Sql for Host {
    fn transaction<'a>(
        &'a self,
        operation: &'static str,
        statements: &'a [SqlStatement<'a>],
    ) -> StoreFuture<'a, Result<Vec<Vec<SqlRow>>, StoreError>> {
        Box::pin(async move {
            let request = serde_json::to_vec(&json!({ "operation": operation, "statements": statements }))
                .map_err(|error| StoreError::Backend(error.to_string()))?;
            let answer = take(unsafe { sql(request.as_ptr(), request.len()) });
            match serde_json::from_slice(&answer) {
                Ok(Answer::Rows(rows)) => Ok(rows),
                Ok(Answer::Error(error)) => Err(StoreError::Backend(error)),
                Err(error) => Err(StoreError::Backend(error.to_string())),
            }
        })
    }
}

#[derive(Deserialize)]
#[serde(tag = "call", rename_all = "snake_case")]
enum Request {
    Submit {
        scope: String,
        writer: String,
        key: String,
        at_ms: u64,
        op: Op,
    },
    View {
        scope: String,
        at_ms: u64,
    },
    Entries {
        scope: String,
        after: u64,
    },
}

const READER: &str = "";

thread_local! {
    static BOARDS: RefCell<BTreeMap<(String, String), Board>> = const { RefCell::new(BTreeMap::new()) };
}

fn settle<T>(future: impl Future<Output = T>) -> Result<T, String> {
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(value) => Ok(value),
        Poll::Pending => Err("the board host suspended a synchronous call".to_owned()),
    }
}

fn with_board(scope: &str, writer: &str, operate: impl FnOnce(&mut Board) -> Result<Value, String>) -> Result<Value, String> {
    BOARDS.with(|boards| {
        let mut boards = boards.borrow_mut();
        let key = (scope.to_owned(), writer.to_owned());
        let board = match boards.entry(key.clone()) {
            btree_map::Entry::Occupied(open) => open.into_mut(),
            btree_map::Entry::Vacant(vacant) => {
                let host = Arc::new(SqlLog::new(Arc::new(Host)));
                vacant.insert(settle(Board::open(host, scope, writer))?.map_err(|error| error.to_string())?)
            }
        };
        let result = operate(board);
        if result.is_err() {
            boards.remove(&key);
        }
        result
    })
}

fn rejection(rejection: &Rejection) -> Value {
    match rejection {
        Rejection::Exists => json!({ "kind": "exists" }),
        Rejection::UnknownTask => json!({ "kind": "unknown_task" }),
        Rejection::UnknownParent(task) => json!({ "kind": "unknown_parent", "task": task }),
        Rejection::UnknownNeed(task) => json!({ "kind": "unknown_need", "task": task }),
        Rejection::Waiting(task) => json!({ "kind": "waiting", "task": task }),
        Rejection::Held { claim, until_ms } => json!({ "kind": "held", "claim": claim, "until_ms": until_ms }),
        Rejection::NotHolder => json!({ "kind": "not_holder" }),
        Rejection::Terminal => json!({ "kind": "terminal" }),
    }
}

fn phase(phase: &Phase) -> Value {
    match phase {
        Phase::Open => json!({ "state": "open" }),
        Phase::Claimed { claim, worker, until_ms } => json!({ "state": "claimed", "claim": claim, "worker": worker, "until_ms": until_ms }),
        Phase::Done { result } => json!({ "state": "done", "result": result }),
        Phase::Failed { error } => json!({ "state": "failed", "error": error }),
        Phase::Cancelled { reason } => json!({ "state": "cancelled", "reason": reason }),
    }
}

fn change(change: &Change) -> Value {
    match change {
        Change::Posted => json!({ "kind": "posted" }),
        Change::Claimed { claim, worker, until_ms, took_over } => json!({ "kind": "claimed", "claim": claim, "worker": worker, "until_ms": until_ms, "took_over": took_over }),
        Change::Renewed { claim, until_ms } => json!({ "kind": "renewed", "claim": claim, "until_ms": until_ms }),
        Change::Released { claim, note } => json!({ "kind": "released", "claim": claim, "note": note }),
        Change::Finished(outcome) => json!({ "kind": "finished", "outcome": outcome }),
        Change::Cancelled { reason } => json!({ "kind": "cancelled", "reason": reason }),
        Change::Replied { by, body } => json!({ "kind": "replied", "by": by, "body": body }),
    }
}

fn entry(entry: &Entry) -> Value {
    json!({ "seq": entry.seq, "event": entry.event, "at_ms": entry.at_ms, "task": entry.task, "change": change(&entry.change) })
}

fn view(fold: &Fold, at_ms: u64) -> Value {
    let tasks = fold
        .tasks()
        .iter()
        .map(|(id, task)| {
            json!({
                "id": id,
                "parent": task.spec.parent,
                "spec": task.spec.spec,
                "labels": task.spec.labels,
                "needs": task.spec.needs,
                "phase": phase(&task.phase),
                "attempts": task.attempts,
                "replies": task.replies.iter().map(|(by, body)| json!({ "by": by, "body": body })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let leases = fold
        .tasks()
        .values()
        .filter_map(|task| match &task.phase {
            Phase::Claimed { until_ms, .. } => Some(*until_ms),
            _ => None,
        })
        .collect::<Vec<_>>();
    json!({
        "next": fold.next(),
        "now_ms": fold.now_ms(),
        "tasks": tasks,
        "ready": fold.ready(at_ms).collect::<Vec<_>>(),
        "settled": fold.settled(),
        "leases": leases,
    })
}

fn answer(request: Request) -> Result<Value, String> {
    match request {
        Request::Submit { scope, writer, key, at_ms, op } => with_board(&scope, &writer, |board| {
            Ok(match settle(board.submit_keyed(&key, at_ms, op))? {
                Ok(applied) => json!({ "applied": { "seq": applied.seq, "event": applied.event } }),
                Err(BoardError::Rejected(refused)) => json!({ "rejected": rejection(&refused) }),
                Err(BoardError::Unsettled { event, error }) => json!({ "unsettled": { "event": event, "error": error.to_string() } }),
                Err(error) => return Err(error.to_string()),
            })
        }),
        Request::View { scope, at_ms } => with_board(&scope, READER, |board| {
            settle(board.refresh())?.map_err(|error| error.to_string())?;
            Ok(view(board.fold(), at_ms))
        }),
        Request::Entries { scope, after } => with_board(&scope, READER, |board| {
            settle(board.refresh())?.map_err(|error| error.to_string())?;
            Ok(json!({
                "next": board.fold().next(),
                "entries": board.fold().entries().iter().filter(|row| row.seq > after).map(entry).collect::<Vec<_>>(),
            }))
        }),
    }
}

fn give(bytes: Vec<u8>) -> u64 {
    let len = bytes.len() as u64;
    let ptr = Box::into_raw(bytes.into_boxed_slice()).cast::<u8>() as usize as u64;
    (ptr << 32) | len
}

fn take(packed: u64) -> Vec<u8> {
    let ptr = (packed >> 32) as usize as *mut u8;
    let len = (packed & u64::from(u32::MAX)) as usize;
    unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) }.into_vec()
}

#[unsafe(no_mangle)]
pub extern "C" fn board_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0_u8; len].into_boxed_slice()).cast::<u8>()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn board_call(ptr: *mut u8, len: usize) -> u64 {
    let request = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) };
    let result = serde_json::from_slice::<Request>(&request)
        .map_err(|error| error.to_string())
        .and_then(answer);
    let body = match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error }),
    };
    give(serde_json::to_vec(&body).unwrap_or_default())
}
