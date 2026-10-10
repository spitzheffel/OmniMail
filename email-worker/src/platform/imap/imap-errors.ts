export class ImapConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly definitive = false,
    /** The server's own wording of a refusal, for logs only; never shown to users. */
    readonly detail = '',
  ) {
    super(message)
  }
}
