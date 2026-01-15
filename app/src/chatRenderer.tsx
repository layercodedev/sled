import { renderToString } from "hono/jsx/dom/server";

type Tone = "info" | "success" | "warning" | "error" | "neutral" | "primary";

type RecordLike = Record<string, unknown>;

const toneBadgeMap: Record<Tone, string> = {
  info: "status-badge--info",
  success: "status-badge--success",
  warning: "status-badge--warning",
  error: "status-badge--error",
  neutral: "status-badge--neutral",
  primary: "status-badge--primary",
};

export function renderConnectionStatusSnippet(label: string, tone: Tone = "info"): string {
  const badgeClass = toneBadgeMap[tone] ?? toneBadgeMap.info;

  return renderToString(
    <span id="connection-status" class={`status-badge ${badgeClass}`} hx-swap-oob="outerHTML" aria-live="polite">
      {label}
    </span>,
  );
}

export function renderAgentHtmlFromNdjson(payload: string): string[] {
  if (!payload) {
    return [];
  }

  return payload
    .split(/\r?\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => renderAgentSegment(segment));
}

function renderAgentSegment(segment: string): string {
  const timestamp = formatTimestamp(new Date());

  try {
    const parsed = JSON.parse(segment) as RecordLike;
    const summary = describeMessage(parsed);
    const badgeTone = toneForSummary(summary);
    const pretty = JSON.stringify(parsed, null, 2);

    return renderToString(
      <div id="chat-message-list" hx-swap-oob="beforeend">
        <article class="agent-message-card">
          <div class="agent-message-header">
            <span>{timestamp}</span>
            <span class={`status-badge ${toneBadgeMap[badgeTone]}`}>{summary}</span>
          </div>
          <pre class="agent-message-pre">{pretty}</pre>
        </article>
      </div>,
    );
  } catch {
    return renderToString(
      <div id="chat-message-list" hx-swap-oob="beforeend">
        <article class="agent-message-card agent-message-card--error">
          <div class="agent-message-header">
            <span>{timestamp}</span>
            <span class={`status-badge ${toneBadgeMap.error}`}>Invalid message</span>
          </div>
          <pre class="agent-message-pre agent-message-pre--error">{segment}</pre>
          <p class="agent-message-note">Failed to parse agent message as JSON.</p>
        </article>
      </div>,
    );
  }
}

export function renderClientEventSnippet(title: string, details?: string): string {
  const timestamp = formatTimestamp(new Date());

  return renderToString(
    <div id="chat-message-list" hx-swap-oob="beforeend">
      <article class="agent-message-card">
        <div class="agent-message-header">
          <span>{timestamp}</span>
          <span class={`status-badge ${toneBadgeMap.primary}`}>Client</span>
        </div>
        <p class="agent-message-title">{title}</p>
        {details ? <pre class="agent-message-pre">{details}</pre> : null}
      </article>
    </div>,
  );
}

function describeMessage(payload: RecordLike): string {
  const label =
    readString(payload, "type") ??
    readString(payload, "event") ??
    readString(payload, "kind") ??
    readSessionUpdate(payload) ??
    readString(payload, "action") ??
    readNestedString(payload, ["result", "type"]) ??
    "Agent Update";

  return formatLabel(label);
}

function readString(record: RecordLike, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNestedString(record: RecordLike, path: string[]): string | undefined {
  let current: unknown = record;

  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as RecordLike)[key];
  }

  return typeof current === "string" && current.trim().length > 0 ? current : undefined;
}

function readSessionUpdate(record: RecordLike): string | undefined {
  const update = record["update"];
  if (!update || typeof update !== "object") {
    return undefined;
  }

  const sessionUpdate = (update as RecordLike)["sessionUpdate"];
  return typeof sessionUpdate === "string" && sessionUpdate.length > 0 ? sessionUpdate : undefined;
}

function toneForSummary(summary: string): Tone {
  const normalized = summary.toLowerCase();
  if (normalized.includes("error") || normalized.includes("fail")) {
    return "error";
  }
  if (normalized.includes("permission") || normalized.includes("tool")) {
    return "warning";
  }
  if (normalized.includes("complete") || normalized.includes("success")) {
    return "success";
  }
  return "info";
}

function formatLabel(label: string): string {
  return label
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(date: Date): string {
  return date.toISOString().slice(11, 19) + "Z";
}
