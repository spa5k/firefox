/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

add_task(async function test_reader_pending_metadata_lifetime() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.ipc.processCount.webIsolated", 1]],
  });
  const prefix = "reader-metadata-lifetime-" + Date.now();
  const sourceURL =
    getRootDirectory(gTestPath).replace(
      "chrome://mochitests/content",
      "https://example.com"
    ) + "readerModeArticleTextPlain.txt";
  const tabs = new Set();
  registerCleanupFunction(async () => {
    for (const tab of tabs) {
      if (tab.parentNode) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
  });

  async function open(url) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
    tabs.add(tab);
    return tab;
  }

  async function close(tab) {
    await BrowserTestUtils.removeTab(tab);
    tabs.delete(tab);
  }

  const guard = await open(sourceURL + "?" + prefix + "guard");
  async function snapshot() {
    return SpecialPowers.spawn(guard.linkedBrowser, [prefix], async tag => {
      for (let i = 0; i < 8; i++) {
        Cu.forceGC();
        Cu.forceCC();
        await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
      }
      const { AboutReaderChild } = ChromeUtils.importESModule(
        "resource:///actors/AboutReaderChild.sys.mjs"
      );
      Assert.ok(
        content.windowGlobalChild.getActor("AboutReader") instanceof
          AboutReaderChild,
        "The probe reads the registered Reader actor"
      );
      const { addDebuggerToGlobal } = ChromeUtils.importESModule(
        "resource://gre/modules/jsdebugger.sys.mjs"
      );
      const sandbox = Cu.Sandbox(
        Services.scriptSecurityManager.getSystemPrincipal(),
        { freshCompartment: true }
      );
      addDebuggerToGlobal(sandbox);
      const dbg = new sandbox.Debugger();
      try {
        const global = dbg.addDebuggee(Cu.getGlobalForObject(AboutReaderChild));
        const scope = global.makeDebuggeeValue(
          AboutReaderChild.prototype.receiveMessage
        ).environment;
        const read = name =>
          scope.find(name)?.getVariable(name).unsafeDereference();
        const pending = read("gPendingDocMetadata");
        const cached = read("gCachedDocMetadata");
        const pendingRecords = pending
          ? [...pending]
              .filter(([, value]) => value.url.includes(tag))
              .map(([browserId, value]) => ({
                browserId,
                url: value.url,
                title: value.title,
              }))
          : [];
        const cachedRecords = cached
          ? [...cached]
              .filter(([url]) => url.includes(tag))
              .map(([url, value]) => ({ url, title: value.title }))
          : [...read("gUrlsToDocTitle")]
              .filter(([url]) => url.includes(tag))
              .map(([url, title]) => ({ url, title }));
        return {
          processID: Services.appinfo.processID,
          pendingRecords,
          cachedRecords,
          records: [...pendingRecords, ...cachedRecords],
        };
      } finally {
        dbg.removeAllDebuggees();
        Cu.nukeSandbox(sandbox);
      }
    });
  }

  const processID = (await snapshot()).processID;
  async function source(name) {
    const url = sourceURL + "?" + prefix + name;
    const title = "Custom source title " + name;
    const tab = await open(url);
    const owner = await SpecialPowers.spawn(
      tab.linkedBrowser,
      [title],
      text => {
        content.document.title = text;
        return {
          browserId: content.browsingContext.browserId,
          processID: Services.appinfo.processID,
        };
      }
    );
    Assert.equal(
      owner.processID,
      processID,
      "The source uses the guard process"
    );
    return { tab, url, title, browserId: owner.browserId };
  }

  async function holdHandoff(item) {
    const actor =
      item.tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor(
        "AboutReader"
      );
    const reached = new Promise(resolve => {
      actor.enterReaderMode = () => resolve();
    });
    actor.sendAsyncMessage("Reader:ToggleReaderMode", {});
    await reached;
  }

  async function readerState(tab) {
    return SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      await ContentTaskUtils.waitForCondition(() => {
        const reader =
          content.windowGlobalChild.getActor("AboutReader")._reader;
        return (
          (!!reader?._article &&
            content.document.body.classList.contains("loaded")) ||
          content.document.documentElement.hasAttribute("data-is-error")
        );
      }, "The Reader load finishes");
      return {
        title: content.document.title,
        failed: content.document.documentElement.hasAttribute("data-is-error"),
        plain: !!content.document.querySelector(".plain-text-doc"),
        hasSourceText: content.document
          .querySelector(".moz-reader-content")
          ?.textContent.includes("Lorem ipsum dolor sit amet"),
        processID: Services.appinfo.processID,
      };
    });
  }

  async function checkReader(tab, title, name, expectPlain = false) {
    const state = await readerState(tab);
    info("READER-METADATA-CONTROL " + JSON.stringify({ name, state }));
    Assert.equal(
      state.processID,
      processID,
      name + " stays in the guard process"
    );
    Assert.ok(
      !state.failed && state.hasSourceText,
      name + " loads the source article"
    );
    if (expectPlain) {
      Assert.ok(state.plain, name + " keeps the plain-text content type");
    }
    Assert.equal(
      state.title,
      title,
      name + " preserves the custom source title"
    );
  }

  const cancelled = await source("cancelled");
  await holdHandoff(cancelled);
  await close(cancelled.tab);
  let state = await snapshot();
  info("READER-METADATA-CANCELLED " + JSON.stringify(state));
  Assert.ok(
    !state.records.some(record => record.url === cancelled.url),
    "Closing an unused hand-off releases its metadata"
  );

  const superseded = await source("superseded");
  await holdHandoff(superseded);
  const replacementURL = sourceURL + "?" + prefix + "replacement";
  const replaced = BrowserTestUtils.browserLoaded(
    superseded.tab.linkedBrowser,
    false,
    replacementURL
  );
  BrowserTestUtils.startLoadingURIString(
    superseded.tab.linkedBrowser,
    replacementURL
  );
  await replaced;
  const replacementTitle = "Custom source title replacement";
  await SpecialPowers.spawn(
    superseded.tab.linkedBrowser,
    [replacementTitle],
    title => {
      content.document.title = title;
    }
  );
  await holdHandoff(superseded);
  state = await snapshot();
  info("READER-METADATA-SUPERSEDED " + JSON.stringify(state));
  Assert.ok(
    !state.records.some(record => record.url === superseded.url),
    "A later hand-off releases the unused older URL"
  );
  Assert.equal(
    state.records.filter(record => record.url === replacementURL).length,
    1,
    "The replacement has one pending record"
  );
  await close(superseded.tab);
  state = await snapshot();
  Assert.ok(
    !state.records.some(record => record.url === replacementURL),
    "Closing the replacement releases its unused metadata"
  );

  const first = await source("first");
  const other = await source("other");
  await holdHandoff(first);
  await holdHandoff(other);
  const direct = await open(
    "about:reader?url=" + encodeURIComponent(first.url)
  );
  await checkReader(direct, first.title, "A live direct transfer");
  state = await snapshot();
  Assert.ok(
    !state.cachedRecords.some(record => record.url === other.url),
    "Reading the first URL does not commit another owner's unused metadata"
  );
  Assert.ok(
    state.records.some(
      record => record.url === other.url && record.title === other.title
    ),
    "The other owner keeps its own pending URL and title"
  );
  await close(other.tab);
  await close(first.tab);
  state = await snapshot();
  Assert.ok(
    !state.records.some(record => record.url === other.url),
    "The other unused owner releases its metadata"
  );
  const loaded = BrowserTestUtils.browserLoaded(direct.linkedBrowser);
  BrowserTestUtils.reloadTab(direct);
  await loaded;
  await checkReader(
    direct,
    first.title,
    "Transferred Reader reload after source close",
    true
  );
  await close(direct);

  const completed = await source("completed");
  const ready = BrowserTestUtils.waitForContentEvent(
    completed.tab.linkedBrowser,
    "AboutReaderContentReady"
  );
  completed.tab.linkedBrowser.browsingContext.currentWindowGlobal
    .getActor("AboutReader")
    .sendAsyncMessage("Reader:ToggleReaderMode", {});
  await ready;
  await checkReader(completed.tab, completed.title, "The normal hand-off");
  state = await snapshot();
  Assert.ok(
    !state.pendingRecords.some(
      record => record.browserId === completed.browserId
    ),
    "The normal consumer releases its pending owner record"
  );
  await close(completed.tab);
  const reopened = await open(
    "about:reader?url=" + encodeURIComponent(completed.url)
  );
  await checkReader(
    reopened,
    completed.title,
    "Direct Reader after all old owners close",
    true
  );
  const reloaded = BrowserTestUtils.browserLoaded(reopened.linkedBrowser);
  BrowserTestUtils.reloadTab(reopened);
  await reloaded;
  await checkReader(
    reopened,
    completed.title,
    "Closed-source direct Reader reload",
    true
  );
  await close(reopened);
  state = await snapshot();
  info("READER-METADATA-FINAL " + JSON.stringify(state));
  Assert.equal(
    state.pendingRecords.length,
    0,
    "No unused hand-off owner remains"
  );
  Assert.equal(
    state.cachedRecords.length,
    2,
    "The two consumed URLs retain the existing historical title behavior"
  );
  await close(guard);
});
