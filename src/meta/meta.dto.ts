/** Public build and contract information, used by clients to detect contract drift. */
export class MetaDto {
  /** Service name. */
  name!: string;

  /** Application (build) version. */
  version!: string;

  /** Semantic version of the HTTP contract this build implements. */
  contractVersion!: string;

  /** URL major version of the API, e.g. `v1`. */
  apiVersion!: string;

  /**
   * Whether any signed-in user may create an organisation (`POST /organisations`). When false the UI
   * explains that organisations are provisioned by a platform administrator instead of offering the form.
   */
  organisationSelfServe!: boolean;

  /**
   * The largest evidence file this deployment accepts, in bytes. The host decides it (a serverless function
   * refuses a body over 4.5 MB before any code runs), so a client reads the limit from here instead of
   * carrying a number of its own into its message to the uploader.
   */
  evidenceMaxBytes!: number;
}
