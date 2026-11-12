"use strict";

// Run after build with Playwright and a Chromium executable installed:
// PLAYWRIGHT_MODULE=/path/to/playwright-core CHROME_EXECUTABLE=/path/to/chrome node tests/graph-wiki-browser.cjs
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright-core",
);
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { openArchive } = require("../lib/archive.cjs");
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
    for (const annotation of scenario.fixture.annotations)
      await archive.addAnnotation(annotation);
    const archivePath = path.join(dir, "archive.json");
    const archiveHash = sha(await fs.readFile(archivePath));
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
    const writes = [];
    let failAnnotations = false;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!["GET", "HEAD"].includes(route.request().method()))
        writes.push(`${route.request().method()} ${url.pathname}`);
      if (url.origin !== base) {
        external.push(url.origin);
        return route.abort();
      }
      if (failAnnotations && url.pathname === "/api/annotations")
        return route.fulfill({
          status: 503,
          body: "Synthetic annotation failure",
        });
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
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
    assert.match(task, /下一步.*Print the route checklist\./);
    const decisions = await page.locator("#project-decisions").innerText();
    assert.match(decisions, /The dry run is Wednesday\./);
    assert.doesNotMatch(decisions, /Print the route checklist\./);

    // The overview must open the task's exact source even if notes fail to load.
    failAnnotations = true;
    const taskEvidenceResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/evidence" &&
        response.request().method() === "GET",
    );
    const annotationFailure = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/annotations" &&
        response.status() === 503,
    );
    await page
      .locator("#project-tasks")
      .getByRole("button", { name: /查看.*证据/ })
      .click();
    const response = await taskEvidenceResponse;
    const requestedCitation = JSON.parse(
      new URL(response.url()).searchParams.get("citation"),
    );
    assert.deepEqual(requestedCitation, {
      id: scenario.references.task.id,
      revision: scenario.references.task.revision,
      source: scenario.references.task.source,
    });
    await annotationFailure;
    await page.getByText("批注加载失败，请重试查看证据").waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector("#evidence")
        .textContent.includes("route-checklist"),
    );
    const taskEvidence = JSON.parse(
      await page.locator("#evidence").innerText(),
    );
    assert.equal(taskEvidence.id, scenario.references.task.id);
    assert.equal(taskEvidence.revision, scenario.references.task.revision);
    assert.deepEqual(taskEvidence.source, scenario.references.task.source);
    assert.equal(taskEvidence.turnId, "dsh-turn-3");
    failAnnotations = false;
    const projectCurrent = await selectFrom(project);
    const topicCurrent = await selectFrom(topic);
    assert.equal(topicCurrent, projectCurrent);

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
    assert.deepEqual(external, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      "PASS: overview task next step and exact evidence despite annotation failure, both entries, real graph/timeline, unchanged source, no writes or external requests",
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
