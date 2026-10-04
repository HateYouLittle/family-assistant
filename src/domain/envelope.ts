/**
 * 响应信封与错误码(设计方案 §5.1 契约冻结)。
 * message 永远是可直接说给家人听的中文(P3);hint 是给模型的下一步建议;
 * 失败时不存在 data。DENIED 必须带 reason。
 */

export const CODES = {
  MISSING_PARAMS: "MISSING_PARAMS",
  INVALID_PARAMS: "INVALID_PARAMS",
  AMBIGUOUS: "AMBIGUOUS",
  DENIED: "DENIED",
  NOT_FOUND: "NOT_FOUND",
} as const;
export type Code = (typeof CODES)[keyof typeof CODES];

/** reason ∈ not_visible / not_writable / immutable / unknown_profile / identity_mismatch */
export type DenyReason =
  | "not_visible"
  | "not_writable"
  | "immutable"
  | "unknown_profile"
  | "identity_mismatch";

export interface MemberCandidate {
  name: string;
  aliases: string[];
}

export interface OkEnvelope {
  ok: true;
  data: unknown;
  message: string;
}

export interface FailEnvelope {
  ok: false;
  code: Code;
  message: string;
  hint?: string;
  reason?: DenyReason;
  missing?: string[];
  candidates?: MemberCandidate[];
  field?: string;
  id?: string;
}

export type Envelope = OkEnvelope | FailEnvelope;

export function okEnvelope(data: unknown, message: string): OkEnvelope {
  return { ok: true, data, message };
}

export function failEnvelope(
  code: Code,
  opts: {
    message: string;
    hint?: string;
    reason?: DenyReason;
    missing?: string[];
    candidates?: MemberCandidate[];
    field?: string;
    id?: string;
  },
): FailEnvelope {
  return { ok: false, code, ...opts };
}

/** 把失败信封包成一条固定形状的空 data,便于类型收窄。 */
export function isFail(env: Envelope): env is FailEnvelope {
  return !env.ok;
}
