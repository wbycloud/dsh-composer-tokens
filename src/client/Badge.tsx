import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TokenizerEngine, EngineResolution } from "./engine/types";
import { HeuristicEngine } from "./engine/heuristic";
import { resolveEngine } from "./engine/registry";
import { countDraft, serializeDraft, type OccurrenceLike, MAX_COUNT_CHARS } from "./serialization";
import { computeBadge, formatCount, costLevel, costStyles, sumUsage, fixedOverhead, type PressureView, type UsageView, type BreakdownView } from "./compute";
import { createTrailingDebouncer } from "./debounce";

const DEBOUNCE_MS = 250;
const MODEL_REQUERY_COOLDOWN_MS = 3000;
const LAST_FIXED_KEY = "dsh-composer-tokens.lastFixedTokens";

/** Previous session's fixed overhead (system+tools heuristic), used as a
 * placeholder for a brand-new session before its first request broadcasts a
 * header. Read defensively; never throws. */
function readLastFixed(): number | undefined {
  try {
    const raw = localStorage.getItem(LAST_FIXED_KEY);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function writeLastFixed(value: number): void {
  try {
    localStorage.setItem(LAST_FIXED_KEY, String(Math.round(value)));
  } catch {
    /* private mode / quota — placeholder only */
  }
}

/** Minimal shapes of handle-ish values crossing the slot boundary (never serialized). */
interface SessionModelsApi {
  sessions?: {
    models?(payload: { sessionId: string }): Promise<{ result?: { ok: boolean; value?: { current?: { provider?: string; model?: string } } } }>;
  };
}

interface TriggerControllerLike {
  serializeReference(source: string, ref: string, signal?: AbortSignal): Promise<string>;
}

interface InputLike {
  draft?: string;
  draftRev?: number;
  phase?: string;
  occurrences?: readonly OccurrenceLike[];
}

export interface TokenMeterBadgeProps {
  /** standard kit */
  useProjection?: (key: string) => unknown;
  sessionId?: string;
  t?: (key: string) => string;
  /** owner props (zone = { session, input }) */
  session?: unknown;
  input?: InputLike;
  /** slot inject */
  api?: SessionModelsApi | null | undefined;
  controller?: TriggerControllerLike | null | undefined;
}

interface DraftCount {
  value: number;
  exact: boolean;
  truncated: boolean;
}

const fallbackEngine: TokenizerEngine = new HeuristicEngine();

function useSessionModel(props: TokenMeterBadgeProps): [string | undefined, () => void] {
  const { api, sessionId } = props;
  const [model, setModel] = useState<string | undefined>(undefined);
  const lastQuery = useRef(0);
  // Reset the cooldown when the session changes so a fresh session is never
  // stuck with a stale (possibly undefined) model for up to 3s.
  useEffect(() => {
    lastQuery.current = 0;
  }, [sessionId]);
  const refresh = useCallback(() => {
    if (api?.sessions?.models === undefined || sessionId === undefined) return;
    const now = Date.now();
    if (now - lastQuery.current < MODEL_REQUERY_COOLDOWN_MS) return;
    lastQuery.current = now;
    api.sessions
      .models({ sessionId })
      .then(({ result }) => {
        if (result?.ok === true) setModel(result.value?.current?.model);
      })
      .catch(() => {
        /* keep the previous model identity */
      });
  }, [api, sessionId]);
  return [model, refresh];
}

/**
 * Boundary component: the slot may temporarily have no session/input while
 * switching between hero, blank, and active conversation states. Keep the
 * conditional outside the Hooks-owning component so its Hook sequence never
 * changes across renders.
 */
export function TokenMeterBadge(props: TokenMeterBadgeProps): null | JSX.Element {
  if (props.sessionId === undefined || props.input === undefined) return null;
  return <TokenMeterBadgeActive {...props} />;
}

function TokenMeterBadgeActive(props: TokenMeterBadgeProps): JSX.Element {
  const { sessionId, input, t, useProjection, api, controller } = props;

  const pressure = (useProjection?.("contextPressure") ?? undefined) as PressureView | undefined;
  const usage = (useProjection?.("tokenUsage") ?? undefined) as UsageView | undefined;
  const breakdown = (useProjection?.("contextBreakdown") ?? undefined) as BreakdownView | undefined;

  const [lastFixed, setLastFixed] = useState<number | undefined>(readLastFixed);

  const [model, refreshModel] = useSessionModel(props);
  const [engineRes, setEngineRes] = useState<EngineResolution>({ status: "heuristic", engine: fallbackEngine, fallbackReason: "unknown-model" });
  const [draftCount, setDraftCount] = useState<DraftCount | null>(null);
  const [hover, setHover] = useState(false);

  // Model identity: on mount/session change (forced), and on projection ticks
  // (cooldown 3s — there is no model-switch wire event, see docs/m0-spike.md V3).
  useEffect(() => {
    refreshModel();
  }, [refreshModel, pressure === undefined, sessionId]);
  useEffect(() => {
    refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Engine: lazy per model id; registry caches by family (LRU).
  useEffect(() => {
    let cancelled = false;
    if (model === undefined) {
      setEngineRes({ status: "heuristic", engine: fallbackEngine, fallbackReason: "unknown-model" });
      return;
    }
    setEngineRes({ status: "loading" });
    resolveEngine(model).then((res) => {
      if (!cancelled) setEngineRes(res);
    });
    return () => {
      cancelled = true;
    };
  }, [model]);

  // Persist the fixed overhead (system+tools heuristic) for fresh-session
  // placeholder use; the first real anchor of this session supersedes it.
  useEffect(() => {
    const fixed = fixedOverhead(breakdown);
    if (fixed > 0) {
      setLastFixed(fixed);
      writeLastFixed(fixed);
    }
  }, [breakdown]);

  const inputDraft = input.draft ?? "";
  const occurrences = input.occurrences ?? [];
  const engine = engineRes.status === "ready" && engineRes.engine !== undefined ? engineRes.engine : fallbackEngine;
  const loading = engineRes.status === "loading";

  // Debounced draft count (250ms trailing, design §4.6). Serialization via the
  // send-path controller (design §4.4); while expanding refs the badge shows
  // the display-text estimate marked `~`.
  useEffect(() => {
    let cancelled = false;
    const current = inputDraft;
    const currentOcc = occurrences;
    const serialize =
      controller === undefined || controller === null
        ? null
        : (occs: readonly OccurrenceLike[]) =>
            serializeDraft(current, occs, (o) => controller.serializeReference(o.source, o.ref)).then(
              (text) => text,
              () => null
            );
    const fire = (payload: { draft: string; occ: readonly OccurrenceLike[] }) => {
      const apply = (r: DraftCount) => {
        if (!cancelled) setDraftCount(r);
      };
      const result = countDraft(payload.draft, payload.occ, (text) => engine.count(text), serialize);
      if (result instanceof Promise) {
        // Display-text estimate now, exact after serialization (or on failure).
        apply({ value: engine.count(payload.draft.trim()), exact: false, truncated: false });
        result.then(apply).catch(() => {});
      } else {
        apply(result);
      }
    };
    const debouncer = createTrailingDebouncer<{ draft: string; occ: readonly OccurrenceLike[] }>(fire, DEBOUNCE_MS);
    debouncer.schedule({ draft: current, occ: currentOcc });
    return () => {
      cancelled = true;
      debouncer.cancel();
    };
  }, [inputDraft, occurrences, engine, controller]);

  const numbers = useMemo(() => {
    const draftTokens = draftCount?.value ?? 0;
    return computeBadge(pressure, draftTokens, engineRes.familyId, inputDraft.trim() === "", breakdown, lastFixed);
  }, [pressure, draftCount, engineRes.familyId, inputDraft, breakdown, lastFixed]);

  // Cost level by ABSOLUTE token count (user reads the badge as "how much
  // this send costs"), not by occupancy %. Colors = green → amber → red.
  const badge = costStyles(costLevel(numbers.total));
  // The「~」marker covers non-exact engines AND estimated baselines
  // (breakdown / last-fixed placeholders); real anchors render「≈」.
  const showLoading = loading && inputDraft.trim() !== "";
  const estimate = numbers.baselineSource !== "anchor" || !(draftCount?.exact ?? false);
  const label =
    showLoading || draftCount === null
      ? t?.("badge.loading") ?? "…"
      : `${estimate ? "~" : "≈"}${formatCount(numbers.total)}${numbers.occupancy !== null ? ` · ${numbers.occupancy}%` : ""}`;

  const usageTotal = sumUsage(usage);
  const modelLabel = model ?? t?.("tooltip.unknownModel") ?? "Unknown model";
  const engineLabel = engineRes.status === "ready" && engineRes.engine !== undefined ? engineRes.engine.label : t?.("tooltip.estimated") ?? "Estimated";

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", alignSelf: "stretch" }}>
      <span
        role="button"
        tabIndex={0}
        aria-label={t?.("badge.aria") ?? "expected token cost"}
        data-composer-tokens-badge=""
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        style={{
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1.2,
          whiteSpace: "nowrap",
          color: badge.color,
          fontVariantNumeric: "tabular-nums",
          cursor: "default",
          padding: "2px 6px",
          border: `1px solid ${badge.borderColor}`,
          borderRadius: 999,
          background: badge.background,
          userSelect: "none",
          opacity: numbers.total === 0 ? 0.55 : 1,
        }}
      >
        {label}
      </span>
      {hover && (
        <span
          role="tooltip"
          data-composer-tokens-tooltip=""
          style={{
            position: "absolute",
            right: 0,
            bottom: "calc(100% + 6px)",
            zIndex: 1000,
            boxSizing: "border-box",
            width: "max-content",
            minWidth: "min(220px, calc(100vw - 16px))",
            maxWidth: "min(320px, calc(100vw - 16px))",
            overflowWrap: "anywhere",
            background: "var(--dsw-specific-tip)",
            border: "1px solid var(--dsw-alias-border-l2)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            padding: "8px 10px",
            fontSize: 12,
            lineHeight: 1.45,
            color: "var(--dsw-alias-label-primary)",
            textAlign: "left",
            whiteSpace: "normal",
          }}
        >
          <span style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>{t?.("tooltip.title") ?? "预计请求"}</span>
          <span style={{ display: "block", fontSize: 16, fontWeight: 700, lineHeight: 1.25, color: badge.color }}>
            {estimate ? "~" : "≈"}{formatCount(numbers.total)} <small style={{ fontSize: 11, fontWeight: 500 }}>tokens</small>
          </span>
          <span style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "2px 14px", marginTop: 8, paddingTop: 7, borderTop: "1px solid var(--dsw-alias-border-l1)" }}>
            <span>{t?.("tooltip.historyShort") ?? "历史"}</span>
            <b>{formatCount(numbers.baseline)}</b>
            <span>{t?.("tooltip.draftShort") ?? "草稿"}</span>
            <b>+{formatCount(numbers.draftTokens)}</b>
            <span>{t?.("tooltip.frameShort") ?? "帧"}</span>
            <b>+{formatCount(numbers.seam)}</b>
          </span>
          <span style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "2px 14px", marginTop: 7, paddingTop: 7, borderTop: "1px solid var(--dsw-alias-border-l1)" }}>
            <span>{t?.("tooltip.levelShort") ?? "级别"}</span>
            <b style={{ color: badge.color }}>{t?.(`tooltip.level.${costLevel(numbers.total)}`) ?? costLevel(numbers.total)}</b>
            {numbers.occupancy !== null && <>
              <span>{t?.("tooltip.windowShort") ?? "窗口"}</span>
              <b>{numbers.occupancy}%</b>
            </>}
            <span>{t?.("tooltip.modelShort") ?? "模型"}</span>
            <span style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }} title={modelLabel}>{modelLabel}</span>
          </span>
          <span style={{ display: "block", marginTop: 7, opacity: 0.72, fontSize: 11 }}>
            {t?.("tooltip.methodShort") ?? "口径"}: {estimate ? t?.("badge.tooltip.estimated") : t?.("badge.tooltip.exact")} · {engineLabel}
          </span>
          <span style={{ display: "block", marginTop: 2, opacity: 0.72, fontSize: 11 }}>
            {t?.("tooltip.usageShort") ?? "累计"}: {formatCount(usageTotal)}
          </span>
          {numbers.baselineSource === "none" && (
            <span style={{ display: "block", marginTop: 5, color: "var(--dsw-alias-state-warn-primary)", fontSize: 11 }}>{t?.("tooltip.calibrate")}</span>
          )}
          {draftCount?.truncated === true && (
            <span style={{ display: "block", marginTop: 5, color: "var(--dsw-alias-state-warn-primary)", fontSize: 11 }}>{t?.("tooltip.truncated")}</span>
          )}
        </span>
      )}
    </span>
  );
}