export class ICloudStoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Dynamic wording kept out of `message`, which the client translates by its exact text. */
    readonly detail = '',
    /** A stable name for the case, for a client that reacts to it rather than just showing it. */
    readonly code = '',
  ) {
    super(message)
  }
}
