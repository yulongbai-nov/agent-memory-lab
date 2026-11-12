"use strict";

// Run after build with Playwright and a Chromium executable installed:
// PLAYWRIGHT_MODULE=/path/to/playwright-core CHROME_EXECUTABLE=/path/to/chrome node tests/graph-wiki-pagination.cjs
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright-core",
);
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { openArchive } = require("../lib/archive.cjs");
const { migrateJsonToSqlite } = require("../lib/storage-sqlite.cjs");
const { originalCapture } = require("../lib/originals.cjs");
const { createWebServer } = require("../lib/web/server.cjs");
const scenario = require("../benchmark/graph-wiki/scenario.json");

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-wiki-e2e-"));
  let archive,
    web,
    browser,
    listening = false;
  try {
    const rawPath = path.join(dir, "synthetic-source.jsonl");
    await fs.writeFile(rawPath, scenario.fixture.originals[0].utf8);
    const originalBytes = await fs.readFile(rawPath);
    const originalHash = sha(originalBytes);
    assert.equal(
      originalHash,
      "2fc3b3ac2f71eef3de056adbececb6a451402c32bc6d265e9624c6c79ff6855e",
    );
    const ref = await originalCapture(dir)({
      bytes: originalBytes,
      coordinate: 1,
    });
    const archivedPath = path.join(dir, "originals", `${ref.sha256}.jsonl`);
    archive = await openArchive({ dir });
    for (const batch of scenario.fixture.batches)
      await archive.importBatch(batch);
    // Separate synthetic session makes the source list exceed several page limits.
    await archive.importBatch({
      scope: scenario.scope,
      source: { harness: "dsh", instance: "fixture", session: "pagination" },
      checkpoint: { position: 1 },
      items: Array.from({ length: 120 }, (_, index) => ({
        id: `pagination-${String(index).padStart(3, "0")}`,
        kind: "message",
        role: "user",
        text: `Synthetic pagination record ${index}`,
        time: new Date(Date.UTC(2026, 3, 8, 0, index)).toISOString(),
        turnId: `pagination-turn-${index}`,
        metadata: { topic: scenario.topic },
      })),
    });
    for (const annotation of scenario.fixture.annotations)
      await archive.addAnnotation(annotation);
    archive.close?.();
    await migrateJsonToSqlite({ dir });
    archive = await openArchive({ dir, readOnly: true });
    assert.equal(archive.backend, "sqlite");
    const archivePath = path.join(dir, "archive.json");
    const archiveHash = sha(await fs.readFile(archivePath));
    const sqlitePath = path.join(dir, "archive.sqlite3");
    const sqliteHash = sha(await fs.readFile(sqlitePath));
    web = createWebServer({
      archive,
      owner: "synthetic",
      project: "moonbridge",
    });
    const { port } = await web.listen();
    listening = true;
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      args: ["--no-first-run"],
    });
    const context = await browser.newContext({ serviceWorkers: "block" });
    const external = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base) {
        external.push(url.origin);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    const sourceResponses = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/topic-sources")
        sourceResponses.push(response.json());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    const project = page.locator("#project-entry");
    const topic = page.locator("#topic-entry");
    assert.equal(await project.isVisible(), true);
    assert.equal(await topic.isVisible(), true);
    assert.equal(
      await project.evaluate(
        (node) =>
          node.parentElement ===
          document.querySelector("#topic-entry").parentElement,
      ),
      true,
    );

    async function selectFrom(entry) {
      await entry.click();
      await page.locator('#search input[name="keyword"]').fill("blue lantern");
      await page.locator("#search button").click();
      await page
        .locator("#topics")
        .getByRole("button", { name: /Moonbridge lantern route/ })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#current")
          .textContent.includes("The dry run is Wednesday."),
      );
      const current = await page.locator("#current").innerText();
      assert.match(current, /已确定/);
      assert.match(current, /The dry run is Wednesday\./);
      assert.match(current, /route-change/);
      await page.waitForFunction(() =>
        document
          .querySelector("#timeline")
          .textContent.includes("Print the route checklist."),
      );
      assert.match(
        await page.locator("#timeline").innerText(),
        /Print the route checklist\./,
      );
      await page.waitForSelector("#graph canvas");
      await page.waitForSelector("#visual-timeline .vis-item");
      assert.ok(await page.locator("#graph canvas").count());
      assert.ok(await page.locator("#visual-timeline .vis-item").count());
      return current;
    }
    await project.click();
    await page.waitForFunction(() =>
      document
        .querySelector("#project-tasks")
        .textContent.includes("Print the route checklist."),
    );
    const task = await page.locator("#project-tasks").innerText();
    assert.match(task, /Print the route checklist\./);
    assert.match(task, /状态：未完成/);
    const projectCurrent = await selectFrom(project);
    const topicCurrent = await selectFrom(topic);
    assert.equal(topicCurrent, projectCurrent);

    // Loading additional source pages must preserve the selected topic and the
    // complete reviewed state, even when source rows cross page boundaries.
    const selectedTopic = await page.locator("#selected-topic").innerText();
    assert.match(selectedTopic, /Moonbridge lantern route/);
    await page
      .locator("#timeline > div")
      .filter({ hasText: "The public walk is Tuesday." })
      .getByRole("button", { name: "查看证据" })
      .click();
    await page.waitForFunction(() =>
      document.querySelector("#evidence").textContent.includes("route-tuesday"),
    );
    const evidenceBefore = await page.locator("#evidence").innerText();
    assert.equal(
      JSON.parse(evidenceBefore).revision,
      scenario.references.original.revision,
    );
    const reviewedBefore = await page.locator("#current").innerText();
    const historyBefore = await page.locator("#timeline").innerText();
    const sourceMore = page.locator("#source-more");
    await sourceMore.waitFor({ state: "visible" });
    let pageCount = 1;
    const cursors = new Set();
    while (await sourceMore.isVisible()) {
      assert.ok(pageCount < 20, "source pagination must terminate");
      const before = await page.locator("#source-history > div").count();
      const requestPromise = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/topic-sources",
      );
      await sourceMore.click();
      const request = await requestPromise;
      const requested = new URL(request.url());
      const cursor = requested.searchParams.get("cursor");
      assert.ok(cursor, "each continuation must send a cursor");
      assert.equal(requested.searchParams.get("topic"), scenario.topic);
      assert.equal(
        cursors.has(cursor),
        false,
        "continuation cursor must advance",
      );
      cursors.add(cursor);
      await page.waitForFunction(
        (previous) =>
          document.querySelector("#source-history").children.length > previous,
        before,
      );
      pageCount++;
      assert.equal(
        await page.locator("#selected-topic").innerText(),
        selectedTopic,
      );
      assert.equal(await page.locator("#current").innerText(), reviewedBefore);
      assert.equal(await page.locator("#timeline").innerText(), historyBefore);
      assert.equal(await page.locator("#evidence").innerText(), evidenceBefore);
      assert.ok(await page.locator("#graph canvas").count());
    }
    assert.ok(pageCount > 1, "fixture must force multiple source pages");
    const sources = await page.locator("#source-history").innerText();
    assert.doesNotMatch(sources, /foreign blue lantern route/i);
    const sourcePages = (await Promise.all(sourceResponses)).slice(-pageCount);
    const citations = sourcePages.flatMap((result) =>
      result.rows.map((row) => row.citation),
    );
    const ids = citations.map((citation) => citation.id);
    for (let index = 0; index < 120; index++) {
      const id = `pagination-${String(index).padStart(3, "0")}`;
      assert.equal(
        ids.filter((value) => value === id).length,
        1,
        `${id} must appear once`,
      );
    }
    assert.equal(
      citations.some(
        (citation) =>
          citation.revision === scenario.references.foreign.revision,
      ),
      false,
    );

    // Current lifecycle is independent of task state in the same visual view.
    const oldDecision = page
      .locator("#visual-timeline .vis-item")
      .filter({ hasText: "The public walk is Tuesday." });
    const newDecision = page
      .locator("#visual-timeline .vis-item")
      .filter({ hasText: "The dry run is Wednesday." });
    const taskItem = page
      .locator("#visual-timeline .vis-item")
      .filter({ hasText: "Print the route checklist." });
    assert.match(await oldDecision.innerText(), /已替代/);
    assert.match(await newDecision.innerText(), /已确定/);
    assert.match(await taskItem.innerText(), /任务.*未完成/);
    assert.doesNotMatch(await taskItem.innerText(), /已确定|已替代/);

    // The historical decision must open the archived old revision, not its newer version.
    await oldDecision.click();
    await page.waitForFunction(() =>
      document.querySelector("#evidence").textContent.includes("route-tuesday"),
    );
    const oldEvidence = JSON.parse(await page.locator("#evidence").innerText());
    assert.equal(oldEvidence.id, scenario.references.original.id);
    assert.deepEqual(oldEvidence.source, scenario.references.original.source);
    assert.equal(oldEvidence.turnId, "dsh-turn-1");
    assert.equal(oldEvidence.revision, scenario.references.original.revision);
    assert.notEqual(oldEvidence.revision, scenario.references.newer.revision);
    assert.equal(oldEvidence.original.availability, "archived");

    // The visible timeline item must invoke the real evidence endpoint with its exact source.
    const item = page
      .locator("#visual-timeline .vis-item")
      .filter({ hasText: "The dry run is Wednesday." });
    await item.waitFor({ state: "visible" });
    await item.click();
    await page.waitForFunction(() =>
      document
        .querySelector("#evidence")
        .textContent.includes("route-wednesday"),
    );
    if (process.env.GRAPH_WIKI_SCREENSHOT)
      await page.screenshot({
        path: process.env.GRAPH_WIKI_SCREENSHOT,
        fullPage: true,
      });
    const evidence = JSON.parse(await page.locator("#evidence").innerText());
    assert.equal(evidence.id, "route-wednesday");
    assert.equal(
      evidence.revision,
      "979326e6c5bf4e4310ff5042bb3b6892dc3ac68bcfa3f8fa612a7d518953a37e",
    );
    assert.deepEqual(evidence.source, {
      harness: "codex",
      instance: "fixture",
      session: "routing",
    });
    assert.equal(evidence.turnId, "codex-turn-1");
    assert.equal(sha(await fs.readFile(rawPath)), originalHash);
    assert.equal(sha(await fs.readFile(archivedPath)), originalHash);
    assert.equal(sha(await fs.readFile(archivePath)), archiveHash);
    assert.equal(sha(await fs.readFile(sqlitePath)), sqliteHash);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      "PASS: bounded multi-page source history, retained reviewed graph and timeline, exact evidence, scope and unchanged source",
    );
  } finally {
    if (browser) await browser.close();
    if (listening) await web.close();
    if (archive && archive.close) await archive.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
