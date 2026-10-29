import BaseOpenAILikeProvider from "../baseOpenAILikeProvider";
import OpenAILite from "@/utils/openai";
import { isOpperUrl } from "@/utils/opper";

export interface OpenAICompatibleConfig {
  provider: string;
  config?: {
    baseURL?: string;
    apiKey?: string;
    model?: string;
    isOTypeModel?: boolean;
  }
}

export interface OpenAICompatibleModel {
  id: string;
  object: string;
  owned_by: string;
}

class OpenAICompatible extends BaseOpenAILikeProvider {
  private baseURL: string = 'https://api.openai.com/v1';
  private apiKey: string | null = null;
  public isExternalProvider: boolean = true;

  public model: string;
  private connectionProvider: string;
  protected client;
  protected isOTypeModel: boolean = false;

  constructor({ provider = 'OpenAICompatible', config = {} }: OpenAICompatibleConfig) {
    super({ provider, config });

    // Random other properties we may or may not need
    for (const key in config) {
      if (config.hasOwnProperty(key)) {
        this[key] = config[key];
      }
    }

    if (config.baseURL) this.baseURL = config.baseURL;
    if (config.apiKey) this.apiKey = config.apiKey;
    this.model = config.model || 'Unknown Model';
    this.connectionProvider = provider;

    this.client = new OpenAILite({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
    });
    this.log(`${this.connectionProvider} initialized with model ${this.model}`);
  }

  /**
   * Arbitrary OpenAI-compatible servers can reject `stream_options` (desktop gates it behind
   * GENERIC_OPEN_AI_REPORT_USAGE for the same reason) - never ask for stream usage.
   * OpenAI itself uses `OpenAIProvider` (Responses API), which always reports usage.
   */
  protected override supportsStreamUsage(): boolean {
    // Opper's compatibility endpoint reports usage like OpenAI, so its token counts are real
    return this.usesOpper;
  }

  /** Whether this connection points at Opper - its replies can then be priced from Opper's listing */
  get usesOpper(): boolean {
    return isOpperUrl(this.baseURL);
  }

  protected log = (text: string, ...args: any[]) => {
    console.log(`\x1b[36m[${this.constructor.name}]\x1b[0m ${text}`, ...args);
  }

  override async availableModels(): Promise<OpenAICompatibleModel[]> {
    return await this.client.models.list()
      .then((models) => models.data.map((model: OpenAICompatibleModel) => model))
      .catch((error) => {
        this.log(`Error fetching models: ${error}`);
        return [];
      });
  }

  async loadNewModel(model: string) {
    this.model = model;
  }

  /**
   * This is a stub method for compliance with the base class.
   * We don't need to unload the model here since that is not supported by this provider.
   */
  async unloadModel() {
    return;
  }
}

export default OpenAICompatible;