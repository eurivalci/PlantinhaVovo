// api/analisar.js — Proxy serverless (Vercel) para a API Google Gemini.
// A chave GEMINI_API_KEY fica SOMENTE no servidor.
// Dois modos:
//   mode:"analise"  -> recebe imagem base64, devolve JSON estruturado de diagnóstico.
//   mode:"pergunta" -> recebe pergunta + contexto da planta, devolve texto da "Vovó".
//
// Versão blindada:
//   - fallback automático de modelo (MODELS abaixo)
//   - responseMimeType tolerante (refaz sem ele se a API recusar)
//   - diagnóstico real do erro propagado ao front quando DEBUG_ERRORS=1 (sem vazar a chave)
//   - tolerância a "thinking" / finishReason MAX_TOKENS (resposta vazia)
// Contrato de entrada/saída IDÊNTICO à versão anterior — o front não muda.

// Ordem de tentativa. O 1º que responder vence. Sobrescreva o principal com GEMINI_MODEL.
const MODELS = [
  process.env.GEMINI_MODEL || "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
].filter((v, i, a) => v && a.indexOf(v) === i);

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const DEBUG = process.env.DEBUG_ERRORS === "1"; // se "1", anexa o motivo técnico à mensagem de erro

const MAX_IMAGE_BASE64 = 6 * 1024 * 1024; // ~6MB
const MAX_PERGUNTA = 600;
const MAX_HISTORICO = 8;
const MIMES_OK = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

const SYSTEM_ANALISE =
  "Você é a 'Vovó', uma botânica brasileira experiente em plantas ornamentais que une o conhecimento técnico " +
  "de jardinagem com a sabedoria popular de quem cuida de plantas a vida toda. Analise a foto da planta enviada. " +
  "Escreva SEMPRE em português do Brasil, com linguagem simples, calorosa e acessível para pessoas idosas, " +
  "sem termos técnicos difíceis. Quando indicar produtos, prefira soluções fáceis de achar no Brasil " +
  "(NPK 10-10-10, calda de sabão neutro, óleo de neem, terra adubada, húmus de minhoca). " +
  "Em 'sabedoria_vovo', traga UMA receita ou dica caseira tradicional brasileira, sempre SEGURA e inofensiva para " +
  "a pessoa e para a planta (ex.: casca de banana picada na terra, borra de café seca como adubo leve, canela em pó " +
  "contra fungo no corte, água do cozimento de legumes já fria sem sal). Nunca sugira nada tóxico, inflamável ou perigoso. " +
  "Responda EXCLUSIVAMENTE com um objeto JSON válido, sem texto antes ou depois, sem markdown, sem crases. " +
  "Estrutura exata:\n" +
  "{\n" +
  '  "e_planta": true,\n' +
  '  "nome_popular": "nome popular em português",\n' +
  '  "nome_cientifico": "Nome científico",\n' +
  '  "familia": "Família botânica",\n' +
  '  "confianca": "alta | média | baixa",\n' +
  '  "saude_status": "Saudável | Atenção | Precisa de cuidados",\n' +
  '  "saude_score": 0,\n' +
  '  "diagnostico": "1 a 3 frases simples sobre como a planta está.",\n' +
  '  "problemas": [ { "titulo": "curto", "descricao": "explicação simples", "gravidade": "alta | média | baixa" } ],\n' +
  '  "cuidados": {\n' +
  '     "rega": "com que frequência regar",\n' +
  '     "luz": "quanta luz precisa",\n' +
  '     "solo": "tipo de terra ideal",\n' +
  '     "umidade_temperatura": "clima ideal",\n' +
  '     "adubacao": "como e quando adubar"\n' +
  '  },\n' +
  '  "onde_vive_melhor": {\n' +
  '     "ambiente": "dentro de casa | varanda | área externa | meia-sombra etc.",\n' +
  '     "local_sugerido": "ex.: perto de uma janela que pega sol da manhã",\n' +
  '     "luminosidade": "ex.: luz indireta e clara",\n' +
  '     "clima_ideal": "ex.: gosta de calor, sofre no frio",\n' +
  '     "dificuldade": "fácil | média | exigente"\n' +
  '  },\n' +
  '  "tratamento": [ "o que aplicar / fazer, passo a passo e bem prático" ],\n' +
  '  "sabedoria_vovo": "uma receita/dica caseira tradicional, segura, escrita com carinho",\n' +
  '  "info_basica": {\n' +
  '     "toxicidade_humanos": "não tóxica | levemente tóxica (irritante) | moderadamente tóxica | altamente tóxica",\n' +
  '     "toxicidade_pets": "não tóxica para pets | levemente tóxica para pets | moderadamente tóxica para pets | altamente tóxica para pets",\n' +
  '     "erva_daninha": "não apresenta risco | pode se espalhar com facilidade | altamente invasiva",\n' +
  '     "vida_util": "ex.: planta perene, vive muitos anos | planta anual, dura uma temporada | arbusto de vida longa"\n' +
  '  },\n' +
  '  "dica": "uma dica carinhosa e fácil de lembrar"\n' +
  "}\n" +
  "Regras: saude_score é número de 0 a 100. Se a imagem NÃO for uma planta, retorne {\"e_planta\": false} e nada mais. " +
  "O array problemas pode ficar vazio se a planta estiver bem.";

const SYSTEM_PERGUNTA =
  "Você é a 'Vovó', uma senhora brasileira sábia e carinhosa que entende muito de plantas — junta botânica com a " +
  "experiência de quem cuidou de plantas a vida toda. Responda em português do Brasil, em poucas frases, com " +
  "linguagem simples e afetuosa, sem termos difíceis. Seja prática e segura. Se sugerir receitas caseiras, apenas " +
  "as tradicionais e inofensivas. Responda só à pergunta da pessoa sobre a planta dela.";

function sanitizeImage(input) {
  if (typeof input !== "string") return null;
  let mime = "image/jpeg";
  let b64 = input;
  if (input.startsWith("data:")) {
    const m = input.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
    if (m) mime = m[1].toLowerCase();
    const comma = input.indexOf(",");
    if (comma === -1) return null;
    b64 = input.slice(comma + 1);
  }
  if (!MIMES_OK.includes(mime)) mime = "image/jpeg";
  if (!b64 || b64.length > MAX_IMAGE_BASE64) return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return null;
  return { mime, b64: b64.replace(/\s+/g, "") };
}

// Tenta fechar um JSON cortado no meio (resposta truncada por limite de tokens):
// remove vírgula/par incompleto no fim e fecha strings, colchetes e chaves abertos.
function repairTruncatedJson(s) {
  let str = s;
  // se terminou no meio de uma string, fecha a aspa
  let inStr = false, esc = false;
  const stack = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) str += '"';
  // remove lixo de um par chave/valor incompleto no final (ex.: ..."rega": )
  str = str.replace(/,\s*$/g, "").replace(/:\s*$/g, ": null").replace(/,\s*([}\]])/g, "$1");
  // fecha o que ficou aberto, na ordem inversa
  for (let i = stack.length - 1; i >= 0; i--) str += stack[i] === "{" ? "}" : "]";
  return str;
}

function extractJson(text) {
  const clean = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = clean.indexOf("{");
  if (start === -1) return null;
  const end = clean.lastIndexOf("}");
  // 1) tentativa direta (resposta completa)
  if (end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) { /* tenta reparar abaixo */ }
  }
  // 2) tentativa de reparo (resposta truncada)
  try {
    const repaired = repairTruncatedJson(clean.slice(start));
    return JSON.parse(repaired);
  } catch (_) { return null; }
}

function textFrom(data) {
  const cand = data && data.candidates && data.candidates[0];
  if (!cand || !cand.content || !Array.isArray(cand.content.parts)) return "";
  return cand.content.parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
}

// Motivo legível p/ logs e (se DEBUG) p/ o front.
function diagnose(data, httpStatus) {
  if (data && data.error) return `api ${data.error.code || httpStatus}: ${data.error.status || ""} ${data.error.message || ""}`.trim();
  if (data && data.promptFeedback && data.promptFeedback.blockReason) return `bloqueio: ${data.promptFeedback.blockReason}`;
  const cand = data && data.candidates && data.candidates[0];
  if (cand && cand.finishReason && cand.finishReason !== "STOP") return `finishReason: ${cand.finishReason}`;
  if (!textFrom(data)) return "resposta sem texto";
  return "ok";
}

// Chama um modelo. rich=true usa config avançada (JSON forçado + thinking desligado);
// rich=false usa config mínima, compatível com qualquer modelo.
async function callModel(apiKey, model, parts, system, maxTokens, rich, forceJson, signal) {
  const generationConfig = { maxOutputTokens: maxTokens, temperature: forceJson ? 0.4 : 0.7 };
  if (rich) {
    if (forceJson) generationConfig.responseMimeType = "application/json";
    // Desliga o "thinking" — senão modelos 2.5 gastam os tokens raciocinando
    // e devolvem resposta vazia com finishReason MAX_TOKENS (causa do 502).
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const payload = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig,
  };
  const r = await fetch(API_BASE + encodeURIComponent(model) + ":generateContent", {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(payload),
  });
  let data = null;
  try { data = await r.json(); } catch (_) { data = null; }
  return { httpOk: r.ok, status: r.status, data };
}

// Tenta modelos em ordem; em cada um, tenta config rica e depois mínima (compatível).
async function generate(apiKey, parts, system, maxTokens, forceJson, signal) {
  let lastDiag = "sem tentativa";
  for (const model of MODELS) {
    for (const rich of [true, false]) {
      const { httpOk, status, data } = await callModel(apiKey, model, parts, system, maxTokens, rich, forceJson, signal);
      const text = textFrom(data).trim();
      if (httpOk && text) return { ok: true, text, model };
      lastDiag = `[${model}${rich ? "+rich" : ""}] ${diagnose(data, status)}`;
      console.error("Gemini tentativa falhou:", lastDiag);
      if (status === 429) return { ok: false, diag: lastDiag, quota: true }; // cota: não adianta insistir
    }
  }
  return { ok: false, diag: lastDiag };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(204).end(); }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método não permitido." });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: "Servidor sem configuração. Defina GEMINI_API_KEY nas variáveis de ambiente da Vercel." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  const mode = body.mode === "pergunta" ? "pergunta" : "analise";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50000);
  const withDiag = (msg, diag, quota) =>
    quota
      ? "A cota gratuita esgotou por enquanto. Tente novamente mais tarde."
      : (DEBUG && diag ? `${msg} [${diag}]` : msg);

  try {
    // ---------- MODO PERGUNTA ----------
    if (mode === "pergunta") {
      const pergunta = typeof body.pergunta === "string" ? body.pergunta.trim().slice(0, MAX_PERGUNTA) : "";
      if (!pergunta) { clearTimeout(timeout); return res.status(400).json({ ok: false, error: "Faça uma pergunta." }); }

      const contexto = typeof body.contexto === "string" ? body.contexto.slice(0, 400) : "";
      const hist = Array.isArray(body.historico) ? body.historico.slice(-MAX_HISTORICO) : [];

      // monta um único turno de usuário com o histórico embutido (simples e robusto)
      let prefixo = "";
      if (contexto) prefixo += "A planta que estou cuidando: " + contexto + "\n";
      for (const m of hist) {
        if (m && typeof m.content === "string") {
          const quem = m.role === "assistant" ? "Vovó" : "Pessoa";
          prefixo += `${quem}: ${m.content.slice(0, 600)}\n`;
        }
      }
      const texto = (prefixo ? prefixo + "Pessoa: " : "") + pergunta;
      const parts = [{ text: texto }];

      const out = await generate(apiKey, parts, SYSTEM_PERGUNTA, 500, false, controller.signal);
      clearTimeout(timeout);
      if (!out.ok) {
        return res.status(502).json({ ok: false, error: withDiag("A Vovó não conseguiu responder agora. Tente de novo em instantes.", out.diag, out.quota) });
      }
      return res.status(200).json({ ok: true, text: out.text });
    }

    // ---------- MODO ANÁLISE ----------
    const img = sanitizeImage(body.image);
    if (!img) { clearTimeout(timeout); return res.status(400).json({ ok: false, error: "Imagem inválida ou muito grande." }); }

    const parts = [
      { inline_data: { mime_type: img.mime, data: img.b64 } },
      { text: "Identifique esta planta, avalie a saúde, diga onde ela vive melhor e o que aplicar. Inclua uma sabedoria caseira da vovó. Responda só com o JSON." },
    ];

    const out = await generate(apiKey, parts, SYSTEM_ANALISE, 8192, true, controller.signal);
    clearTimeout(timeout);
    if (!out.ok) {
      return res.status(502).json({ ok: false, error: withDiag("Não foi possível analisar agora. Tente novamente em instantes.", out.diag, out.quota) });
    }
    const parsed = extractJson(out.text);
    if (!parsed) {
      console.error("JSON não extraído. Texto:", out.text.slice(0, 300));
      return res.status(502).json({ ok: false, error: withDiag("Resposta inesperada. Tente outra foto com mais luz.", "json-parse", false) });
    }
    return res.status(200).json({ ok: true, data: parsed });

  } catch (err) {
    clearTimeout(timeout);
    const aborted = err && err.name === "AbortError";
    console.error("Falha no proxy", err && err.message);
    return res.status(aborted ? 504 : 500).json({
      ok: false,
      error: aborted ? "Demorou demais. Tente novamente." : "Erro inesperado no servidor.",
    });
  }
}
