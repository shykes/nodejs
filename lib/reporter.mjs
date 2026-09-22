/**
 * An OpenTelemetry reporter for Node's built-in test runner.
 *
 * jest and vitest have to hook their runner's internals from the outside,
 * with import-in-the-middle, because neither exposes the run as data.
 * node:test does: a reporter is an async generator over the event stream, so
 * this needs no patching at all. It is a plain consumer of a public API.
 *
 * Node calls it with --test-reporter, which also works inside NODE_OPTIONS,
 * so the project's own test script stays untouched.
 */
import { OtelSDK } from "@dagger.io/telemetry";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  ATTR_TEST_CASE_NAME,
  ATTR_TEST_CASE_RESULT_STATUS,
  ATTR_TEST_SUITE_NAME,
  TEST_CASE_RESULT_STATUS_VALUE_FAIL,
  TEST_CASE_RESULT_STATUS_VALUE_PASS,
} from "@opentelemetry/semantic-conventions/incubating";

const ATTR_UI_BOUNDARY = "dagger.io/ui.boundary";
const STDIO_STREAM = "stdio.stream";

const sdk = new OtelSDK();
sdk.start();

const tracer = trace.getTracer("dagger.io/node-test");
const logger = logs.getLogger("dagger.io/node-test");

/** One span per file, so tests nest under the file that holds them. */
const files = new Map();

/** Start times keyed by file and name, so a span covers the real interval. */
const started = new Map();

function fileSpan(file) {
  const name = file ?? "tests";
  let entry = files.get(name);
  if (!entry) {
    const span = tracer.startSpan(name, {
      attributes: { [ATTR_TEST_SUITE_NAME]: name, [ATTR_UI_BOUNDARY]: true },
    });
    entry = { span, ctx: trace.setSpan(context.active(), span), failed: false };
    files.set(name, entry);
  }
  return entry;
}

const key = (data) => `${data.file ?? ""}\u0000${data.nesting ?? 0}\u0000${data.name}`;

/**
 * node:test reports a duration but no start time. Prefer the moment the
 * test:start event arrived; fall back to subtracting the duration, which is
 * still right to within the reporting delay.
 */
function interval(data) {
  const end = Date.now();
  const recorded = started.get(key(data));
  started.delete(key(data));
  const duration = data.details?.duration_ms ?? 0;
  return { start: recorded ?? end - duration, end };
}

function finish(data, ok) {
  const parent = fileSpan(data.file);
  const { start, end } = interval(data);

  const span = tracer.startSpan(
    data.name,
    {
      startTime: start,
      attributes: {
        [ATTR_TEST_CASE_NAME]: data.name,
        [ATTR_TEST_CASE_RESULT_STATUS]: ok
          ? TEST_CASE_RESULT_STATUS_VALUE_PASS
          : TEST_CASE_RESULT_STATUS_VALUE_FAIL,
        [ATTR_TEST_SUITE_NAME]: data.file ?? "tests",
      },
    },
    parent.ctx,
  );

  if (!ok) {
    parent.failed = true;
    const error = data.details?.error;
    span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message ?? "failed" });
    if (error) span.recordException(error);
  }
  span.end(end);

  if (process.env.DAGGER_NODE_TEST_DEBUG) {
    const ctx = span.spanContext();
    process.stdout.write(
      `SPAN ok=${ok} trace=${ctx.traceId.slice(0, 8)} span=${ctx.spanId} name=${data.name}\n`,
    );
  }
}

function emit(data, stream) {
  const body = String(data.message ?? "").replace(/\n$/, "");
  if (!body) return;
  const parent = files.get(data.file ?? "tests");
  logger.emit({
    body,
    severityNumber: stream === 2 ? SeverityNumber.ERROR : SeverityNumber.INFO,
    context: parent?.ctx,
    attributes: { [STDIO_STREAM]: stream },
  });
}

export default async function* reporter(source) {
  try {
    for await (const event of source) {
      const data = event.data ?? {};
      switch (event.type) {
        case "test:start":
          started.set(key(data), Date.now());
          break;
        case "test:pass":
          // A suite reports a pass of its own; its children already have spans.
          if (data.details?.type !== "suite") finish(data, true);
          break;
        case "test:fail":
          if (data.details?.type !== "suite") finish(data, false);
          break;
        case "test:stdout":
          emit(data, 1);
          break;
        case "test:stderr":
          emit(data, 2);
          break;
      }
    }
  } finally {
    for (const { span, failed } of files.values()) {
      if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    await sdk.shutdown();
  }
}
