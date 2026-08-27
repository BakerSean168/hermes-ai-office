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
    const hosts = [
      this.#defaultHost,
      ...Object.values(this.#byBackend),
      ...Object.values(this.#byConversationPrefix),
    ];
    const uniqueHosts = [...new Set(hosts)];
    const states = await Promise.all(uniqueHosts.map((host) => host.health()));
    if (states.every((state) => state === 'OK')) return 'OK' as const;
    if (states.every((state) => state === 'UNCONFIGURED')) return 'UNCONFIGURED' as const;
    if (states.every((state) => state === 'UNAVAILABLE' || state === 'UNCONFIGURED')) {
      return 'UNAVAILABLE' as const;
    }
    return 'DEGRADED' as const;
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
