export class AIProviderError extends Error {
  constructor(message, { status = 502, code = 'AI_PROVIDER_ERROR', details = null } = {}) {
    super(message);
    this.name = 'AIProviderError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function requestJson(url, options, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
      throw new AIProviderError(`فشل مزود الذكاء الاصطناعي: ${message}`, {
        status: response.status >= 400 && response.status < 500 ? 400 : 502,
        code: `AI_HTTP_${response.status}`
      });
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new AIProviderError('انتهت مهلة استجابة مزود الذكاء الاصطناعي', { code: 'AI_TIMEOUT' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class RulesOnlyProvider {
  async testConnection() { return { ok: true, message: 'وضع الردود الجاهزة لا يحتاج اتصالًا خارجيًا' }; }
  async generateResponse() { throw new AIProviderError('وضع الردود الجاهزة لا يولد نصوصًا', { status: 400, code: 'RULES_ONLY' }); }
}

export class OllamaProvider {
  constructor({ baseUrl = 'http://localhost:11434', model }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }
  async testConnection() {
    const data = await requestJson(`${this.baseUrl}/api/tags`, { method: 'GET' }, 10000);
    return { ok: true, models: (data.models || []).map((item) => item.name) };
  }
  async generateResponse({ system, messages, temperature = 0.2 }) {
    if (!this.model) throw new AIProviderError('اختر نموذج Ollama', { status: 400 });
    const data = await requestJson(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        options: { temperature },
        messages: [{ role: 'system', content: system }, ...messages]
      })
    });
    return { text: data?.message?.content || '', usage: data?.eval_count || 0, raw: data };
  }
}

export class OpenAICompatibleProvider {
  constructor({ baseUrl = 'https://api.openai.com/v1', apiKey, model }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
  }
  async testConnection() {
    const data = await requestJson(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` }
    }, 12000);
    return { ok: true, modelCount: Array.isArray(data.data) ? data.data.length : null };
  }
  async generateResponse({ system, messages, temperature = 0.2 }) {
    const data = await requestJson(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, ...messages]
      })
    });
    return {
      text: data?.choices?.[0]?.message?.content || '',
      usage: Number(data?.usage?.total_tokens || 0),
      raw: data
    };
  }
}

export class AnthropicProvider {
  constructor({ baseUrl = 'https://api.anthropic.com', apiKey, model, apiVersion = '2023-06-01' }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.apiVersion = apiVersion;
  }
  async testConnection() {
    const data = await requestJson(`${this.baseUrl}/v1/models`, {
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': this.apiVersion }
    }, 12000);
    return { ok: true, modelCount: Array.isArray(data.data) ? data.data.length : null };
  }
  async generateResponse({ system, messages, temperature = 0.2 }) {
    const data = await requestJson(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1200,
        temperature,
        system,
        messages
      })
    });
    return {
      text: (data.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n'),
      usage: Number(data?.usage?.input_tokens || 0) + Number(data?.usage?.output_tokens || 0),
      raw: data
    };
  }
}

export class GeminiProvider {
  constructor({ baseUrl = 'https://generativelanguage.googleapis.com/v1beta', apiKey, model }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
  }
  async testConnection() {
    const data = await requestJson(`${this.baseUrl}/models`, {
      headers: { 'x-goog-api-key': this.apiKey }
    }, 12000);
    return { ok: true, modelCount: Array.isArray(data.models) ? data.models.length : null };
  }
  async generateResponse({ system, messages, temperature = 0.2 }) {
    const input = messages.map((message) => `${message.role}: ${message.content}`).join('\n');
    const data = await requestJson(`${this.baseUrl}/interactions`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        system_instruction: system,
        input,
        generation_config: { temperature }
      })
    });
    const textBlocks = [];
    if (typeof data.output_text === 'string') textBlocks.push(data.output_text);
    for (const step of data.steps || []) {
      for (const content of step.content || []) {
        if (content.type === 'text' && content.text) textBlocks.push(content.text);
      }
    }
    return { text: textBlocks.join('\n'), usage: 0, raw: data };
  }
}

export function createAIProvider(settings, decryptedApiKey = '') {
  const common = { baseUrl: settings.base_url || undefined, apiKey: decryptedApiKey, model: settings.model };
  switch (settings.provider) {
    case 'ollama': return new OllamaProvider(common);
    case 'openai_compatible': return new OpenAICompatibleProvider(common);
    case 'anthropic': return new AnthropicProvider(common);
    case 'gemini': return new GeminiProvider(common);
    default: return new RulesOnlyProvider();
  }
}
