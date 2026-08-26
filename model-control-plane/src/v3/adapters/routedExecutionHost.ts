import type {
  ExecutionHostCreateInput,
  ExecutionHostPort,
  ExecutionHostSnapshot,
} from '../ports.js';

export class RoutedExecutionHost implements ExecutionHostPort {
  readonly #defaultHost: ExecutionHostPort;
  readonly #byBackend: Readonly<Record<string, ExecutionHostPort>>;
  readonly #byConversationPrefix: Readonly<Record<string, ExecutionHostPort>>;

  constructor(options: {
    defaultHost: ExecutionHostPort;
    byBackend?: Readonly<Record<string, ExecutionHostPort>>;
    byConversationPrefix?: Readonly<Record<string, ExecutionHostPort>>;
  }) {
    this.#defaultHost = options.defaultHost;
    this.#byBackend = options.byBackend ?? {};
    this.#byConversationPrefix = options.byConversationPrefix ?? {};
  }

  async health() {
    return this.#defaultHost.health();
  }

  createExecution(input: ExecutionHostCreateInput): Promise<ExecutionHostSnapshot> {
    return (this.#byBackend[input.selection.backend] ?? this.#defaultHost).createExecution(input);
  }

  #hostForConversation(conversationId: string): ExecutionHostPort {
    for (const [prefix, host] of Object.entries(this.#byConversationPrefix)) {
      if (conversationId.startsWith(prefix)) return host;
    }
    return this.#defaultHost;
  }

  getExecution(conversationId: string): Promise<ExecutionHostSnapshot> {
    return this.#hostForConversation(conversationId).getExecution(conversationId);
  }

  cancelExecution(conversationId: string): Promise<ExecutionHostSnapshot> {
    return this.#hostForConversation(conversationId).cancelExecution(conversationId);
  }

  continueExecution(conversationId: string, message: string): Promise<ExecutionHostSnapshot> {
    const host = this.#hostForConversation(conversationId);
    if (!host.continueExecution) throw new Error('EXECUTION_CONTINUATION_UNSUPPORTED');
    return host.continueExecution(conversationId, message);
  }
}
