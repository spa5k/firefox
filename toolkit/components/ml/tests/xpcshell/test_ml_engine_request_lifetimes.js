/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { MLEngine } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ml/actors/MLEngineParent.sys.mjs"
);

function wait(ms) {
  return new Promise(resolve => {
    const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.initWithCallback({ notify: resolve }, ms, Ci.nsITimer.TYPE_ONE_SHOT);
  });
}

async function forceCollection() {
  for (let pass = 0; pass < 10; pass++) {
    Cu.forceGC();
    Cu.forceCC();
    await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
  }
}

function keepUntilSettled(promise, value) {
  promise.then(
    () => value,
    () => value
  );
}

function timeoutFailure(message) {
  return wait(1000).then(() => {
    throw new Error(message);
  });
}

function makeEngine(engineId, childID) {
  let childPort;
  const requestIds = [];
  const mlEngineParent = {
    childID,
    sendAsyncMessage(name, data) {
      Assert.equal(name, "MLEngine:NewPort", "unexpected actor message");
      childPort = data.port;
      childPort.onmessage = event => {
        if (event.data.type === "EnginePort:Run") {
          requestIds.push(event.data.requestId);
        } else if (event.data.type === "EnginePort:Terminate") {
          childPort.postMessage({ type: "EnginePort:EngineTerminated" });
        }
      };
      childPort.postMessage({ type: "EnginePort:EngineReady" });
    },
  };
  const pipelineOptions = {
    engineId,
    featureId: "test",
    flowId: null,
    modelId: "test-model",
    backend: "test-backend",
    getOptions() {
      return {
        engineId: this.engineId,
        featureId: this.featureId,
        flowId: this.flowId,
        modelId: this.modelId,
        backend: this.backend,
      };
    },
  };
  const engine = new MLEngine({
    mlEngineParent,
    pipelineOptions,
    notificationsCallback: null,
  });
  return {
    engine,
    get childPort() {
      return childPort;
    },
    async waitForRequestIds(count) {
      for (let pass = 0; requestIds.length < count && pass < 100; pass++) {
        await wait(1);
      }
      Assert.greaterOrEqual(
        requestIds.length,
        count,
        "received the expected run messages"
      );
      return requestIds.splice(0, count);
    },
  };
}

function crashSubjectFor(childID) {
  return {
    QueryInterface: ChromeUtils.generateQI(["nsIPropertyBag2"]),
    get(name) {
      return { abnormal: true, childID, osPid: 4242 }[name];
    },
  };
}

async function cleanUpEngine(engineId, childPort) {
  await MLEngine.removeInstance(engineId, false, false);
  childPort?.close();
}

add_task(async function test_crash_rejects_pending_requests() {
  const engineId = "test-crash-pending-requests";
  const actor = makeEngine(engineId, 73);
  await actor.engine.setupPortCommunication();

  let owner = { bytes: new Uint8Array(1024 * 1024) };
  const ownerRef = new WeakRef(owner);
  let runPromise = actor.engine.run({ args: ["pending run"] });
  keepUntilSettled(runPromise, owner);
  owner = null;

  let generator = actor.engine.runWithGenerator({ args: ["pending stream"] });
  let firstChunk = generator.next();
  firstChunk.catch(() => {});
  await actor.waitForRequestIds(2);
  await forceCollection();
  Assert.notEqual(
    ownerRef.deref(),
    undefined,
    "the pending caller continuation retains its owner"
  );

  Assert.throws(
    () => actor.engine.observe(crashSubjectFor(73), "ipc:content-shutdown"),
    /inference process was shutdown/,
    "the observer reports the simulated process crash"
  );
  await Assert.rejects(
    Promise.race([
      runPromise,
      timeoutFailure("timed out waiting for the pending run to reject"),
    ]),
    /inference process was shutdown/,
    "the pending run rejects"
  );
  await Assert.rejects(
    Promise.race([
      firstChunk,
      timeoutFailure("timed out waiting for the generator to reject"),
    ]),
    /inference process has crashed/,
    "the pending generator rejects"
  );

  runPromise = null;
  firstChunk = null;
  generator = null;
  await forceCollection();
  Assert.equal(
    ownerRef.deref(),
    undefined,
    "the settled caller continuation can be collected"
  );

  await cleanUpEngine(engineId, actor.childPort);
});

add_task(async function test_termination_rejects_pending_requests() {
  const engineId = "test-terminated-pending-requests";
  const actor = makeEngine(engineId, 74);
  await actor.engine.setupPortCommunication();

  const runPromise = actor.engine.run({ args: ["pending run"] });
  const generator = actor.engine.runWithGenerator({ args: ["pending stream"] });
  const firstChunk = generator.next();
  firstChunk.catch(() => {});
  await actor.waitForRequestIds(2);

  actor.childPort.postMessage({ type: "EnginePort:EngineTerminated" });
  await Assert.rejects(
    Promise.race([
      runPromise,
      timeoutFailure("timed out waiting for the terminated run to reject"),
    ]),
    /terminated/,
    "the pending run rejects"
  );
  await Assert.rejects(
    Promise.race([
      firstChunk,
      timeoutFailure(
        "timed out waiting for the terminated generator to reject"
      ),
    ]),
    /terminated/,
    "the pending generator rejects"
  );
  Assert.equal(actor.engine.engineStatus, "closed", "the engine is closed");

  await cleanUpEngine(engineId, actor.childPort);
});

add_task(async function test_null_port_does_not_allocate_requests() {
  const engineId = "test-null-port-requests";
  const actor = makeEngine(engineId, 75);

  await Assert.rejects(
    actor.engine.run({ args: ["no port"] }),
    /Port does not exist/,
    "run fails before it allocates a request"
  );
  const generator = actor.engine.runWithGenerator({ args: ["no port"] });
  await Assert.rejects(
    generator.next(),
    /port is null/,
    "the generator fails before it allocates a request"
  );

  await actor.engine.setupPortCommunication();
  const runPromise = actor.engine.run({ args: ["live"] });
  const [requestId] = await actor.waitForRequestIds(1);
  Assert.equal(requestId, 0, "failed calls did not consume request IDs");
  actor.engine.handlePortMessage(
    {
      data: {
        type: "EnginePort:RunResponse",
        requestId,
        response: { metrics: {} },
        error: null,
        resourcesBefore: null,
        resourcesAfter: null,
      },
    },
    null
  );
  await runPromise;

  await cleanUpEngine(engineId, actor.childPort);
});

add_task(async function test_send_failure_removes_requests() {
  const engineId = "test-send-failure-requests";
  const actor = makeEngine(engineId, 76);
  await actor.engine.setupPortCommunication();

  await Assert.rejects(
    actor.engine.run({ args: [() => {}] }),
    /could not be cloned/,
    "run reports a structured-clone failure"
  );
  const generator = actor.engine.runWithGenerator({ args: [() => {}] });
  await Assert.rejects(
    generator.next(),
    /could not be cloned/,
    "the generator reports a structured-clone failure"
  );

  let staleResponses = 0;
  actor.engine.telemetry = {
    recordRunInferenceSuccessFlow() {
      staleResponses++;
    },
  };
  for (const requestId of [0, 1]) {
    actor.engine.handlePortMessage(
      {
        data: {
          type: "EnginePort:RunResponse",
          requestId,
          response: { metrics: {} },
          error: null,
          resourcesBefore: null,
          resourcesAfter: null,
        },
      },
      null
    );
  }
  Assert.equal(staleResponses, 0, "failed sends left no active requests");

  await cleanUpEngine(engineId, actor.childPort);
});
