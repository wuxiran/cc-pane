use super::*;
use std::sync::Mutex as SyncMutex;

const FAKE_SERVER: &str = r#"
import json,sys,os,time
thread='native-thread'; active=None; waiting=None; background=False
trace=os.path.join(os.getcwd(),'rpc-trace.jsonl')
def send(v): print(json.dumps(v),flush=True)
def result(i,v): send({'id':i,'result':v})
def event(m,p): send({'method':m,'params':p,'pid':os.getpid()})
def complete(status='completed'):
 global active
 event('turn/completed',{'threadId':thread,'turn':{'id':active,'status':status,'items':[],'error':None}});active=None
for line in sys.stdin:
 v=json.loads(line);m=v.get('method');p=v.get('params',{});i=v.get('id')
 if m:
  with open(trace,'a') as f:f.write(json.dumps({'method':m,'params':p,'pid':os.getpid()})+'\n')
 if not m:
  if waiting==i:
   waiting=None
   event('serverRequest/resolved',{'threadId':thread,'requestId':i})
   complete()
  continue
 if m=='initialize':result(i,{'userAgent':'fixture'})
 elif m=='initialized':pass
 elif m in ['thread/start','thread/resume','thread/fork']:
  time.sleep(0.03)
  if len(sys.argv)>1 and sys.argv[1]=='block-thread-start':continue
  if p.get('threadId')=='missing':send({'id':i,'error':{'code':-32602,'message':'missing thread'}});continue
  thread='fork-child' if m=='thread/fork' else p.get('threadId','native-thread')
  turns=[] if m=='thread/start' else [{'id':'old-turn','status':'completed','items':[{'type':'userMessage','id':'u','content':[{'type':'text','text':'Earlier question'}]},{'type':'agentMessage','id':'a','text':'Earlier answer'}]}]
  result(i,{'thread':{'id':thread,'status':{'type':'idle'},'historyMode':'legacy','turns':turns},'cwd':os.getcwd(),'model':'fixture-model','reasoningEffort':'high'})
 elif m=='model/list':result(i,{'data':[{'id':'fixture-model','model':'fixture-model','displayName':'Fixture','hidden':False,'defaultReasoningEffort':'high','supportedReasoningEfforts':[{'reasoningEffort':'high','description':'High'}]}],'nextCursor':None})
 elif m=='turn/start':
  active='turn-1';text=p['input'][0].get('text','')
  result(i,{'turn':{'id':active,'status':'inProgress','items':[]}})
  event('turn/started',{'threadId':thread,'turn':{'id':active}})
  if text=='permission':
   waiting='approval-1'
   send({'id':waiting,'method':'item/commandExecution/requestApproval','params':{'threadId':thread,'turnId':active,'itemId':'cmd','command':'echo example','availableDecisions':['accept','decline','cancel']}})
  elif text=='question':
   waiting='question-1'
   send({'id':waiting,'method':'item/tool/requestUserInput','params':{'threadId':thread,'turnId':active,'itemId':'question','questions':[{'id':'choice','header':'Choose','question':'Which?','options':[{'label':'One'},{'label':'Two'}]}]}})
  elif text=='command':
   event('item/started',{'threadId':thread,'turnId':active,'item':{'type':'commandExecution','id':'cmd','command':'example','cwd':os.getcwd(),'status':'inProgress'}})
   event('item/commandExecution/outputDelta',{'threadId':thread,'turnId':active,'itemId':'cmd','delta':'one'})
   event('item/commandExecution/outputDelta',{'threadId':thread,'turnId':active,'itemId':'cmd','delta':'two'})
   event('item/completed',{'threadId':thread,'turnId':active,'item':{'type':'commandExecution','id':'cmd','command':'example','cwd':os.getcwd(),'status':'completed','aggregatedOutput':None,'exitCode':7}})
   complete()
  elif text=='stale':
   send({'id':'stale-approval','method':'item/commandExecution/requestApproval','params':{'threadId':thread,'turnId':'old-turn','itemId':'old','command':'never run'}})
   event('item/agentMessage/delta',{'threadId':thread,'turnId':'old-turn','itemId':'old-message','delta':'STALE TEXT'})
   event('turn/completed',{'threadId':thread,'turn':{'id':'old-turn','status':'completed'}})
   complete()
  elif text!='wait':
   if text=='background':background=True
   with open('changed.txt','w') as f:f.write('after')
   event('item/agentMessage/delta',{'threadId':thread,'turnId':active,'itemId':'message','delta':'Native '})
   event('item/agentMessage/delta',{'threadId':thread,'turnId':active,'itemId':'message','delta':'answer'})
   event('item/completed',{'threadId':thread,'turnId':active,'item':{'id':'message','type':'agentMessage','text':'Native answer'}})
   complete()
 elif m=='turn/interrupt':result(i,{});complete('interrupted')
 elif m=='thread/backgroundTerminals/list':result(i,{'data':[{'id':'background'}] if background else [],'nextCursor':None})
 else:send({'id':i,'error':{'code':-32601,'message':'unsupported '+m}})
with open(trace,'a') as f:f.write(json.dumps({'method':'process-exited','pid':os.getpid()})+'\n')
"#;

struct Fixture {
    _temp: tempfile::TempDir,
    cwd: PathBuf,
    service: Arc<AcpChatService>,
    events: Arc<SyncMutex<Vec<AcpChatEvent>>>,
    spec: AcpLaunchSpec,
}
impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo");
        std::fs::create_dir(&cwd).unwrap();
        for args in [
            vec!["init", "-q"],
            vec![
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
        ] {
            assert!(std::process::Command::new("git")
                .args(args)
                .current_dir(&cwd)
                .status()
                .unwrap()
                .success());
        }
        let script = temp.path().join("server.py");
        std::fs::write(&script, FAKE_SERVER).unwrap();
        let events = Arc::new(SyncMutex::new(Vec::new()));
        let spec = AcpLaunchSpec {
            engine_id: ENGINE.into(),
            command: ["python3", "python"]
                .into_iter()
                .find(|program| {
                    std::process::Command::new(program)
                        .arg("--version")
                        .output()
                        .is_ok_and(|output| output.status.success())
                })
                .expect("Python is required for the native stdio fixture")
                .into(),
            args: vec!["-u".into(), script.to_string_lossy().into()],
            cwd: cwd.to_string_lossy().into(),
            mcp_servers: vec![
                json!({"type":"http","name":"ccpanes","url":"http://127.0.0.1/mcp?token=fixture"}),
            ],
            resume_acp_session_id: None,
            fork_acp_session_id: None,
            auto_approve_kinds: vec![],
        };
        let service = Arc::new(AcpChatService::new(temp.path().join("data/agent-chats")));
        Self {
            _temp: temp,
            cwd,
            service,
            events,
            spec,
        }
    }
    async fn start(&self, chat: &str, spec: AcpLaunchSpec) -> AppResult<AcpChatSnapshot> {
        let events = self.events.clone();
        self.service
            .start_native_with(
                chat,
                spec,
                Arc::new(move |event| events.lock().unwrap().push(event)),
            )
            .await
    }
    async fn event(&self, kind: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(event) = self
                    .events
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|event| event.kind == kind)
                {
                    return event.payload.clone();
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn native_facade_preserves_identity_stream_journal_checkpoints_and_settings() {
    let f = Fixture::new().await;
    let ready = f.start("chat", f.spec.clone()).await.unwrap();
    assert_eq!(ready.codex_thread_id.as_deref(), Some("native-thread"));
    assert_eq!(ready.engine_id, ENGINE);
    assert_eq!(
        f.service.snapshot("chat").await.unwrap().phase,
        AcpChatPhase::Ready
    );
    assert!(f
        .service
        .set_model("chat", "not-advertised".into())
        .await
        .is_err());
    f.service
        .set_config_option("chat", "reasoning_effort".into(), json!("high"))
        .await
        .unwrap();
    assert_eq!(
        f.service
            .prompt_and_wait("chat", vec![json!({"type":"text","text":"hello"})])
            .await
            .unwrap(),
        "end_turn"
    );
    let updates = f
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.kind == "update")
        .map(|e| e.payload.clone())
        .collect::<Vec<_>>();
    let text = updates
        .iter()
        .filter(|value| value["update"]["sessionUpdate"] == "agent_message_chunk")
        .filter_map(|value| value["update"]["content"]["text"].as_str())
        .collect::<String>();
    assert_eq!(text, "Native answer");
    let records = f
        .service
        .list_run_records(journal::RunFilter {
            chat_id: Some("chat".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(records.runs[0].status, "completed");
    assert_eq!(records.runs[0].engine_id, ENGINE);
    let checkpoints = f.service.checkpoints.list("chat").unwrap();
    assert_eq!(checkpoints.len(), 1);
    assert!(f
        .service
        .checkpoints
        .review(&checkpoints[0].id)
        .unwrap()
        .files
        .iter()
        .any(|file| file.path == "changed.txt" && file.after_content.as_deref() == Some("after")));
    let trace = std::fs::read_to_string(f.cwd.join("rpc-trace.jsonl")).unwrap();
    assert!(trace.contains("mcp_servers.ccpanes"));
    assert!(trace.contains("workspaceWrite"));
    assert!(!trace.contains("dangerFullAccess"));
    f.service.cleanup_all().await;
}

#[tokio::test]
async fn native_permission_question_cancel_and_resume_are_real_protocol_paths() {
    let f = Fixture::new().await;
    f.start("chat", f.spec.clone()).await.unwrap();
    f.service
        .prompt("chat", vec![json!({"type":"text","text":"permission"})])
        .await
        .unwrap();
    let permission = f.event("permission_request").await;
    let key = permission["requestKey"].as_str().unwrap();
    assert!(f
        .service
        .respond_permission("chat", key.into(), Some("acceptForSession".into()))
        .await
        .is_err());
    f.service
        .respond_permission("chat", key.into(), Some("accept".into()))
        .await
        .unwrap();
    f.event("turn_ended").await;
    f.events.lock().unwrap().clear();
    f.service
        .prompt("chat", vec![json!({"type":"text","text":"question"})])
        .await
        .unwrap();
    let question = f.event("elicitation_request").await;
    f.service
        .respond_elicitation(
            "chat",
            question["requestKey"].as_str().unwrap().into(),
            json!({"action":"accept","content":{"choice":"One"}}),
        )
        .await
        .unwrap();
    f.event("turn_ended").await;
    f.events.lock().unwrap().clear();
    f.service
        .prompt("chat", vec![json!({"type":"text","text":"wait"})])
        .await
        .unwrap();
    assert!(f
        .service
        .prompt("chat", vec![json!({"type":"text","text":"second"})])
        .await
        .is_err());
    f.service.cancel("chat").await.unwrap();
    assert_eq!(f.event("turn_ended").await["stopReason"], "cancelled");
    f.service.stop("chat").await.unwrap();
    let mut spec = f.spec.clone();
    spec.resume_acp_session_id = Some("native-thread".into());
    f.start("resumed", spec).await.unwrap();
    assert!(f
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|event| event.kind == "history_replay" && event.payload["phase"] == "commit"));
    let mut fork = f.spec.clone();
    fork.fork_acp_session_id = Some("native-thread".into());
    assert_eq!(
        f.start("child", fork)
            .await
            .unwrap()
            .codex_thread_id
            .as_deref(),
        Some("fork-child")
    );
    let mut missing = f.spec.clone();
    missing.resume_acp_session_id = Some("missing".into());
    assert!(f.start("missing", missing).await.is_err());
    f.service.cleanup_all().await;
}

#[tokio::test]
async fn native_start_replacement_is_serialized_and_reclaims_every_owned_process() {
    let f = Fixture::new().await;
    let (one, two) = tokio::join!(
        f.start("same", f.spec.clone()),
        f.start("same", f.spec.clone())
    );
    one.unwrap();
    two.unwrap();
    assert_eq!(f.service.native_sessions.read().await.len(), 1);
    f.service.cleanup_all().await;
    let trace = std::fs::read_to_string(f.cwd.join("rpc-trace.jsonl")).unwrap();
    let exited = trace
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|entry| entry["method"] == "process-exited")
        .count();
    assert_eq!(
        exited, 2,
        "Both started App Servers must reach EOF, including the replaced owner"
    );
}

#[tokio::test]
async fn native_stale_turn_events_never_enter_new_approvals_or_journal() {
    let f = Fixture::new().await;
    let mut spec = f.spec.clone();
    spec.auto_approve_kinds = vec!["*".into()];
    f.start("chat", spec).await.unwrap();
    assert_eq!(
        f.service
            .prompt_and_wait("chat", vec![json!({"type":"text","text":"stale"})])
            .await
            .unwrap(),
        "end_turn"
    );
    assert!(!f
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|event| event.kind == "permission_request"
            || event.payload.to_string().contains("STALE TEXT")));
    let runs = f
        .service
        .list_run_records(journal::RunFilter::default())
        .await
        .unwrap();
    let events = f
        .service
        .read_run_events(runs.runs[0].id.clone(), 0)
        .await
        .unwrap();
    assert!(!events
        .events
        .iter()
        .any(|event| event.payload.to_string().contains("STALE TEXT")));
    f.service.cleanup_all().await;
}

#[tokio::test]
#[ignore = "Opt-in live Codex App Server test; creates a new private read-only conversation and makes one model request"]
async fn native_live_read_only_facade_smoke() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().join("repo");
    std::fs::create_dir(&cwd).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&cwd)
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-qm",
            "initial"
        ])
        .current_dir(&cwd)
        .status()
        .unwrap()
        .success());
    let service = Arc::new(AcpChatService::new(temp.path().join("data/agent-chats")));
    let engine = crate::commands::ResolvedEngine {
        id: ENGINE.into(),
        label: "Codex App Server".into(),
        executable: "codex".into(),
        args: vec!["app-server".into(), "--listen".into(), "stdio://".into()],
        requirement: "Logged-in Codex CLI".into(),
    };
    let spec = crate::commands::resolve_engine_launch(&engine, cwd.to_str().unwrap()).unwrap();
    let events = Arc::new(SyncMutex::new(Vec::new()));
    let observed = events.clone();
    let snapshot = service
        .start_native_with(
            "native-live",
            spec,
            Arc::new(move |event| observed.lock().unwrap().push(event)),
        )
        .await
        .unwrap();
    service
        .set_mode("native-live", "read-only".into())
        .await
        .unwrap();
    let result=tokio::time::timeout(Duration::from_secs(120),service.prompt_and_wait("native-live",vec![json!({"type":"text","text":"Reply with exactly CC_PANES_NATIVE_FACADE_OK. Do not use tools, read files, access the network beyond this model reply, or change any files."})])).await;
    service.cleanup_all().await;
    assert_eq!(result.unwrap().unwrap(), "end_turn");
    let text = events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| {
            event.kind == "update"
                && event.payload["update"]["sessionUpdate"] == "agent_message_chunk"
        })
        .filter_map(|event| {
            event.payload["update"]["content"]["text"]
                .as_str()
                .map(str::to_owned)
        })
        .collect::<String>();
    assert!(text.contains("CC_PANES_NATIVE_FACADE_OK"), "{text}");
    assert!(!cwd.join("changed.txt").exists());
    println!(
        "Native facade smoke completed: thread={}",
        snapshot.codex_thread_id.unwrap()
    );
}

#[tokio::test]
async fn a_stalled_start_does_not_block_another_chats_stop() {
    let f = Fixture::new().await;
    f.start("ready", f.spec.clone()).await.unwrap();
    let mut blocked = f.spec.clone();
    blocked.args.push("block-thread-start".into());
    let service = f.service.clone();
    let starting = tokio::spawn(async move {
        service
            .start_native_with("blocked", blocked, Arc::new(|_| {}))
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if f.service
                .native_sessions
                .read()
                .await
                .contains_key("blocked")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), f.service.stop("ready"))
        .await
        .unwrap()
        .unwrap();
    starting.abort();
    let _ = starting.await;
    f.service.stop("blocked").await.unwrap();
    f.service.cleanup_all().await;
}

#[tokio::test]
async fn native_command_stream_finishes_with_accumulated_output_and_real_exit_code() {
    let f = Fixture::new().await;
    f.start("command", f.spec.clone()).await.unwrap();
    f.service
        .prompt_and_wait("command", vec![json!({"type":"text","text":"command"})])
        .await
        .unwrap();
    let final_output = f
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.kind == "terminal_output")
        .last()
        .unwrap()
        .payload
        .clone();
    assert_eq!(final_output["output"], "onetwo");
    assert_eq!(final_output["exitStatus"]["exitCode"], 7);
    f.service.cleanup_all().await;
}

#[cfg(unix)]
#[tokio::test]
async fn native_symlink_cwd_cannot_bypass_the_background_restore_guard() {
    let f = Fixture::new().await;
    let alias = f._temp.path().join("alias");
    std::os::unix::fs::symlink(&f.cwd, &alias).unwrap();
    let mut spec = f.spec.clone();
    spec.cwd = alias.to_string_lossy().into_owned();
    f.start("aliased", spec).await.unwrap();
    f.service
        .prompt_and_wait("aliased", vec![json!({"type":"text","text":"background"})])
        .await
        .unwrap();
    let canonical = dunce::canonicalize(&f.cwd).unwrap();
    assert!(f.service.has_background_tools_in(&canonical).await);
    assert_eq!(
        f.service.native_session("aliased").await.unwrap().cwd,
        canonical
    );
    f.service.cleanup_all().await;
}

/// 外部提交的接纳是原子的：回合进行中被拒绝时，不广播公告、不消耗前言；
/// 占到回合后公告先于回复事件，前言并进 prompt 后才算用掉。
#[tokio::test]
async fn announced_prompt_is_atomic_and_preamble_survives_rejection() {
    let f = Fixture::new().await;
    f.start("chat", f.spec.clone()).await.unwrap();
    f.service
        .prompt("chat", vec![json!({"type":"text","text":"wait"})])
        .await
        .unwrap();
    f.service
        .set_next_prompt_preamble("chat", Some("PERSONA".into()));
    let announce = PromptAnnouncement {
        kind: "external_prompt".into(),
        payload: json!({"text":"from im","promptId":"p1"}),
    };
    let rejected = f
        .service
        .prompt_and_wait_announced(
            "chat",
            vec![json!({"type":"text","text":"from im"})],
            Some(announce.clone()),
        )
        .await
        .unwrap_err();
    assert_eq!(rejected.code(), Some("ACP_TURN_IN_PROGRESS"));
    assert!(!f
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|event| event.kind == "external_prompt"));
    assert_eq!(f.service.preambles.peek("chat").as_deref(), Some("PERSONA"));
    f.service.cancel("chat").await.unwrap();
    f.event("turn_ended").await;
    f.events.lock().unwrap().clear();
    assert_eq!(
        f.service
            .prompt_and_wait_announced(
                "chat",
                vec![json!({"type":"text","text":"from im"})],
                Some(announce),
            )
            .await
            .unwrap(),
        "end_turn"
    );
    let kinds: Vec<String> = f
        .events
        .lock()
        .unwrap()
        .iter()
        .map(|event| event.kind.clone())
        .collect();
    let announced = kinds.iter().position(|kind| kind == "external_prompt");
    let first_update = kinds.iter().position(|kind| kind == "update");
    assert!(announced.is_some() && announced < first_update, "{kinds:?}");
    assert!(f.service.preambles.peek("chat").is_none());
    let trace = std::fs::read_to_string(f.cwd.join("rpc-trace.jsonl")).unwrap();
    let sent = trace
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .rfind(|line| line["method"] == "turn/start")
        .unwrap();
    let text = sent["params"]["input"][0]["text"].as_str().unwrap();
    assert!(
        text.starts_with("PERSONA") && text.ends_with("from im"),
        "{text}"
    );
}
