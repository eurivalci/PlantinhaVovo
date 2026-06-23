// api/analisar.js — Proxy serverless (Vercel) para a API Google Gemini.
// A chave GEMINI_API_KEY fica SOMENTE no servidor.
// Dois modos:
//   mode:"analise"  -> recebe imagem base64, devolve JSON estruturado de diagnóstico.
//   mode:"pergunta" -> recebe pergunta + contexto da planta, devolve texto da "Vovó".
//
// Contrato de entrada/saída IDÊNTICO à versão Anthropic — o front não muda.

// gemini-2.5-flash: free tier estável com visão. (2.0 Flash foi descontinuado.)
// Sobrescreva com a env var GEMINI_MODEL se quiser testar 3.5-flash etc.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

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
  '  "dica": "uma dica carinhosa e fácil de lembrar"\n' +
  "}\n" +
  "Regras: saude_score é número de 0 a 100. Se a imagem NÃO for uma planta, retorne {\"e_planta\": false} e nada mais. " +
  "O array problemas pode ficar vazio se a planta estiver bem.";

const SYSTEM_PERGUNTA =
  "Você é a 'Vovó', uma senhora brasileira sábia e carinhosa que entende muito de plantas — junta botânica com a " +
  "experiência de quem cuidou de plantas a vida toda. Responda em português do Brasil, em poucas frases, com " +
  "linguagem simples e afetuosa, sem termos difíceis. Seja prática e segura. Se sugerir receitas caseiras, apenas " +
  "as tradicionais e inofensivas. Responda só à pergunta da pessoa sobre a planta dela.";

// Detecta o mime do data URL e devolve { mime, b64 } já limpo. Null se inválido.
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
  if (!MIMES_OK.includes(mime)) mime = "image/jpeg"; // Gemini é tolerante; jpeg é o fallback seguro
  if (!b64 || b64.length > MAX_IMAGE_BASE64) return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return null;
  return { mime, b64: b64.replace(/\s+/g, "") };
}

function extractJson(text) {
  const clean = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) { return null; }
}

// Extrai texto da resposta do Gemini (candidates[].content.parts[].text).
function textFrom(data) {
  const cand = data && data.candidates && data.candidates[0];
  if (!cand || !cand.content || !Array.isArray(cand.content.parts)) return "";
  return cand.content.parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
}

// Identifica bloqueios por segurança / prompt para log e mensagem amigável.
function blockReason(data) {
  if (data && data.promptFeedback && data.promptFeedback.blockReason) return data.promptFeedback.blockReason;
  const cand = data && data.candidates && data.candidates[0];
  if (cand && cand.finishReason && cand.finishReason !== "STOP" && cand.finishReason !== "MAX_TOKENS") return cand.finishReason;
  return null;
}

async function callGemini(apiKey, payload, signal) {
  return fetch(API_BASE + encodeURIComponent(MODEL) + ":generateContent", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });
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

  try {
    // ---------- MODO PERGUNTA (chat com a Vovó) ----------
    if (mode === "pergunta") {
      const pergunta = typeof body.pergunta === "string" ? body.pergunta.trim().slice(0, MAX_PERGUNTA) : "";
      if (!pergunta) { clearTimeout(timeout); return res.status(400).json({ ok: false, error: "Faça uma pergunta." }); }

      const contexto = typeof body.contexto === "string" ? body.contexto.slice(0, 400) : "";
      const hist = Array.isArray(body.historico) ? body.historico.slice(-MAX_HISTORICO) : [];

      // Gemini usa "contents" com role "user" | "model" (assistant -> model).
      const contents = [];
      if (contexto) {
        contents.push({ role: "user", parts: [{ text: "A planta que estou cuidando: " + contexto }] });
        contents.push({ role: "model", parts: [{ text: "Certo, meu bem, pode perguntar sobre ela." }] });
      }
      for (const m of hist) {
        if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
          contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content.slice(0, 600) }] });
        }
      }
      contents.push({ role: "user", parts: [{ text: pergunta }] });

      const payload = {
        system_instruction: { parts: [{ text: SYSTEM_PERGUNTA }] },
        contents,
        generationConfig: { maxOutputTokens: 500, temperature: 0.7 },
      };

      const apiRes = await callGemini(apiKey, payload, controller.signal);
      clearTimeout(timeout);
      if (!apiRes.ok) {
        const detail = await apiRes.text().catch(() => "");
        console.error("Gemini erro (pergunta)", apiRes.status, detail.slice(0, 300));
        return res.status(502).json({ ok: false, error: "A Vovó não conseguiu responder agora. Tente de novo em instantes." });
      }
      const data = await apiRes.json();
      const block = blockReason(data);
      if (block) console.warn("Gemini bloqueio (pergunta):", block);
      const text = textFrom(data).trim();
      return res.status(200).json({ ok: true, text: text || "Desculpe, meu bem, não entendi. Pode perguntar de outro jeito?" });
    }

    // ---------- MODO ANÁLISE (imagem) ----------
    const img = sanitizeImage(body.image);
    if (!img) { clearTimeout(timeout); return res.status(400).json({ ok: false, error: "Imagem inválida ou muito grande." }); }

    const payload = {
      system_instruction: { parts: [{ text: SYSTEM_ANALISE }] },
      contents: [{
        role: "user",
        parts: [
          { inline_data: { mime_type: img.mime, data: img.b64 } },
          { text: "Identifique esta planta, avalie a saúde, diga onde ela vive melhor e o que aplicar. Inclua uma sabedoria caseira da vovó. Responda só com o JSON." },
        ],
      }],
      // responseMimeType força saída JSON pura — mais robusto que só pedir no prompt.
      generationConfig: { maxOutputTokens: 1600, temperature: 0.4, responseMimeType: "application/json" },
    };

    const apiRes = await callGemini(apiKey, payload, controller.signal);
    clearTimeout(timeout);
    if (!apiRes.ok) {
      const detail = await apiRes.text().catch(() => "");
      console.error("Gemini erro (analise)", apiRes.status, detail.slice(0, 300));
      return res.status(502).json({ ok: false, error: "Não foi possível analisar agora. Tente novamente em instantes." });
    }
    const data = await apiRes.json();
    const block = blockReason(data);
    if (block) console.warn("Gemini bloqueio (analise):", block);
    const parsed = extractJson(textFrom(data));
    if (!parsed) return res.status(502).json({ ok: false, error: "Resposta inesperada. Tente outra foto com mais luz." });
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
