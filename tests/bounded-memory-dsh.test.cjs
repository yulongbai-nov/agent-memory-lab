"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const {
  createBoundedRelay,
  toolReceipt,
  sse,
  toolCatalog,
} = require("../lib/bounded-memory-relay.cjs");
test("DSH flat calls retain provider objects and require matching receipts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-relay-"));
  try {
    const ledger = path.join(dir, "ledger");
    fs.writeFileSync(ledger, "");
    const key = "synthetic-key",
      prompt = "Synthetic prompt",
      context = "Synthetic runtime context";
    const g = createBoundedRelay(ledger, {
      argumentKey: key,
      prompt,
      runInstructions: "synthetic",
      finalSchema: { type: "object" },
      dialect: "dsh",
      dshRuntimeContext: context,
    });
    const base = {
      model: "gpt-6-luna",
      reasoning: { effort: "low" },
      stream: true,
      store: false,
      input: [
        { role: "developer", content: "discard" },
        { role: "user", content: [{ type: "input_text", text: prompt }] },
        { role: "user", content: [{ type: "input_text", text: context }] },
      ],
    };
    assert.equal(toolCatalog("dsh")[0].name, "mcp__memory__memory_find");
    assert.throws(
      () =>
        g.body({
          ...base,
          input: [
            ...base.input,
            { role: "user", content: [{ type: "input_text", text: "extra" }] },
          ],
        }),
      /unknown-user-content/,
    );
    const wire = JSON.parse(g.body(base).wire);
    assert.equal(wire.tools.length, 3);
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "mcp__memory__memory_find",
      arguments: '{"keyword":"x"}',
      status: "completed",
    };
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "opaque",
      status: "completed",
    };
    g.response(
      sse({
        id: "resp_1",
        model: "gpt-6-luna",
        status: "completed",
        output: [reasoning, call],
      }),
    );
    const output = { topics: [] },
      args = { keyword: "x" };
    fs.writeFileSync(
      ledger,
      JSON.stringify({
        tool: "memory_find",
        proof: toolReceipt("memory_find", args, output, key),
      }) + "\n",
    );
    const next = {
      ...base,
      input: [
        ...base.input,
        { ...reasoning, status: undefined },
        { ...call, status: undefined },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify(output),
        },
      ],
    };
    delete next.input[3].status;
    delete next.input[4].status;
    assert.throws(
      () =>
        g.body({
          ...next,
          input: [
            ...next.input.slice(0, -1),
            { ...next.input.at(-1), output: '{"topics":[1]}' },
          ],
        }),
      /tool-output-not-issued/,
    );
    const result = JSON.parse(g.body(next).wire);
    assert.deepEqual(result.input.slice(1, 3), [reasoning, call]);
    assert.equal(result.input[3].output, JSON.stringify(output));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DSH rejects unknown tools and oversized or malformed outputs before forwarding", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-deny-"));
  try {
    const ledger = path.join(dir, "ledger");
    fs.writeFileSync(ledger, "");
    const opts = {
      argumentKey: "key",
      prompt: "prompt",
      runInstructions: "instructions",
      finalSchema: { type: "object" },
      dialect: "dsh",
      dshRuntimeContext: "context",
    };
    const base = {
      model: "gpt-6-luna",
      reasoning: { effort: "low" },
      stream: true,
      store: false,
      input: [
        { role: "user", content: [{ type: "input_text", text: "prompt" }] },
      ],
    };
    function opened(name = "mcp__memory__memory_find") {
      const gate = createBoundedRelay(ledger, opts);
      gate.body(base);
      const call = {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name,
        arguments: "{}",
        status: "completed",
      };
      return { gate, call };
    }
    const bad = opened("mcp__memory__memory_coverage");
    assert.throws(
      () =>
        bad.gate.response(
          sse({
            id: "resp_1",
            model: "gpt-6-luna",
            status: "completed",
            output: [bad.call],
          }),
        ),
      /unknown-tool/,
    );
    for (const output of ["{", "x".repeat(65537)]) {
      const { gate, call } = opened();
      gate.response(
        sse({
          id: "resp_1",
          model: "gpt-6-luna",
          status: "completed",
          output: [call],
        }),
      );
      const next = {
        ...base,
        input: [
          ...base.input,
          call,
          { type: "function_call_output", call_id: "call_1", output },
        ],
      };
      assert.throws(
        () => gate.body(next),
        /tool-output-(?:unrecognized|shape)/,
      );
      assert.equal(gate.summary().forwarded, 1);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DSH evidence is charged to aggregate excerpt budget", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-budget-"));
  try {
    const ledger = path.join(dir, "ledger"),
      key = "key";
    fs.writeFileSync(ledger, "");
    const gate = createBoundedRelay(ledger, {
      argumentKey: key,
      prompt: "prompt",
      runInstructions: "instructions",
      finalSchema: { type: "object" },
      dialect: "dsh",
      dshRuntimeContext: "context",
    });
    const base = {
      model: "gpt-6-luna",
      reasoning: { effort: "low" },
      stream: true,
      store: false,
      input: [
        { role: "user", content: [{ type: "input_text", text: "prompt" }] },
      ],
    };
    let input = [...base.input];
    gate.body({ ...base, input });
    let rejected = false;
    for (let i = 0; i < 12; i++) {
      const args = { id: "E1", revision: "V1" },
        out = {
          ref: "E1",
          at: "2026-01-01T00:00:00.000Z",
          excerpt: "x".repeat(512),
          redacted: false,
        },
        call = {
          type: "function_call",
          id: `fc_${i}`,
          call_id: `call_${i}`,
          name: "mcp__memory__memory_evidence",
          arguments: JSON.stringify(args),
          status: "completed",
        };
      gate.response(
        sse({
          id: `resp_${i}`,
          model: "gpt-6-luna",
          status: "completed",
          output: [call],
        }),
      );
      fs.appendFileSync(
        ledger,
        JSON.stringify({
          tool: "memory_evidence",
          proof: toolReceipt("memory_evidence", args, out, key),
        }) + "\n",
      );
      input.push(call, {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(out),
      });
      try {
        gate.body({ ...base, input });
      } catch (e) {
        assert.match(e.message, /aggregate-quote-budget/);
        rejected = true;
        break;
      }
    }
    assert.equal(rejected, true);
    assert.ok(gate.summary().excerptBytes >= 512);
    assert.ok(gate.summary().budgetBytes <= 4096);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
