// @effect-diagnostics globalTimers:off -- This protocol broker owns cancellable request deadlines outside the Effect runtime.
import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  type DesktopAppActivationFailure,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";

interface PendingActivation {
  readonly request: DesktopAppActivationRequest;
  readonly resolve: (response: DesktopAppActivationResponse) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  dispatched: boolean;
}

type RendererSender = (request: DesktopAppActivationRequest) => void;

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    ok: false,
    code,
    message,
  };
}

/** Holds CLI requests until the real desktop renderer is ready to handle them. */
export class DesktopAppActivationBroker {
  readonly #pending = new Map<string, PendingActivation>();
  readonly #requestTimeoutMs: number;
  readonly #chatGPTRequestTimeoutMs: number;
  readonly #activate: () => void;
  #renderer: RendererSender | null = null;
  #closed = false;

  constructor(input: {
    readonly requestTimeoutMs: number;
    readonly chatGPTRequestTimeoutMs?: number;
    readonly activate: () => void;
  }) {
    this.#requestTimeoutMs = input.requestTimeoutMs;
    this.#chatGPTRequestTimeoutMs = input.chatGPTRequestTimeoutMs ?? input.requestTimeoutMs;
    this.#activate = input.activate;
  }

  request(request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> {
    // The generic pipe authenticates neither an operator nor a catalog model.
    // Refuse before focus, queueing or renderer-side project/thread effects.
    if (request.type === "t3.threads" && request.action === "create") {
      return Promise.resolve(
        failure(
          request.requestId,
          "invalid-request",
          "Native creation requires an authenticated one-use spawn approval; the approval authority is unavailable.",
        ),
      );
    }
    if (this.#closed) {
      return Promise.resolve(
        failure(request.requestId, "renderer-unavailable", "T3 Code is shutting down."),
      );
    }
    if (this.#pending.has(request.requestId)) {
      return Promise.resolve(
        failure(request.requestId, "invalid-request", "The request id is already in use."),
      );
    }

    const response = new Promise<DesktopAppActivationResponse>((resolve) => {
      const timeout = setTimeout(
        () => {
          const pending = this.#pending.get(request.requestId);
          const uncertain =
            pending?.dispatched &&
            (request.type === "chatgpt.spawn" ||
              request.type === "chatgpt.sessions" ||
              request.type === "openrig.human_inbox");
          this.#settle(
            failure(
              request.requestId,
              "request-timeout",
              uncertain
                ? "Outcome UNKNOWN: the request reached the desktop renderer, but its final response was not received. Side effects (including session creation or a sent message) may already have occurred. Inspect the exact session before acting; do not automatically retry."
                : "The desktop app did not receive or complete the queued request in time.",
            ),
          );
        },
        request.type === "chatgpt.spawn" ||
          request.type === "chatgpt.sessions" ||
          request.type === "openrig.human_inbox"
          ? this.#chatGPTRequestTimeoutMs
          : this.#requestTimeoutMs,
      );
      this.#pending.set(request.requestId, {
        request,
        resolve,
        timeout,
        dispatched: false,
      });
    });

    // Agent-spawn requests must not steal focus from the user's current T3
    // thread (or a different application). The already-running renderer can
    // create and drive ChatGPT's browser tab without activating the window.
    if (
      request.type !== "chatgpt.spawn" &&
      request.type !== "chatgpt.sessions" &&
      request.type !== "openrig.human_inbox"
    )
      this.#activate();
    this.#flush();
    return response;
  }

  registerRenderer(send: RendererSender): void {
    this.#renderer = send;
    this.#flush();
  }

  clearRenderer(): void {
    this.#renderer = null;
    for (const pending of this.#pending.values()) {
      if (
        pending.dispatched &&
        pending.request.type !== "chatgpt.spawn" &&
        pending.request.type !== "chatgpt.sessions" &&
        pending.request.type !== "openrig.human_inbox"
      ) {
        this.#settle(
          failure(
            pending.request.requestId,
            "renderer-unavailable",
            "The T3 Code window closed before it opened the project.",
          ),
        );
      }
      // A dispatched ChatGPT/OpenRig command may already have created a session
      // or sent a message. Never replay it on renderer re-registration; accept a
      // late completion if one arrives, otherwise report UNKNOWN at the deadline.
    }
  }

  complete(response: DesktopAppActivationResponse): void {
    this.#settle(response);
  }

  cancel(requestId: string): void {
    const pending = this.#pending.get(requestId);
    this.#settle(
      failure(
        requestId,
        "renderer-unavailable",
        pending?.dispatched
          ? "The command disconnected after renderer dispatch. Outcome UNKNOWN; do not retry without inspecting the destination."
          : "The command closed before T3 Code was ready.",
      ),
    );
  }

  close(): void {
    this.#closed = true;
    this.#renderer = null;
    for (const pending of this.#pending.values()) {
      this.#settle(
        failure(
          pending.request.requestId,
          "renderer-unavailable",
          pending.dispatched
            ? "T3 Code is shutting down after dispatch. Outcome UNKNOWN; inspect the destination before retrying."
            : "T3 Code is shutting down before dispatch.",
        ),
      );
    }
  }

  #flush(): void {
    const renderer = this.#renderer;
    if (renderer === null) return;
    if ([...this.#pending.values()].some((pending) => pending.dispatched)) return;

    for (const pending of this.#pending.values()) {
      if (pending.dispatched) continue;
      try {
        pending.dispatched = true;
        renderer(pending.request);
      } catch {
        // A synchronous bridge failure does not prove that a side-effecting
        // request was not handed off. Only ordinary workspace requests may be
        // retried on a newly registered renderer.
        if (
          pending.request.type !== "chatgpt.spawn" &&
          pending.request.type !== "chatgpt.sessions" &&
          pending.request.type !== "openrig.human_inbox"
        )
          pending.dispatched = false;
        this.#renderer = null;
      }
      return;
    }
  }

  #settle(response: DesktopAppActivationResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(response.requestId);
    pending.resolve(response);
    this.#flush();
  }
}
