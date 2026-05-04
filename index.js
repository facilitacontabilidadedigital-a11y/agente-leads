const express = require("express");
const OpenAI = require("openai").default;
const axios = require("axios");

const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const EVO_URL       = process.env.EVO_URL       || "https://evolution-api-production-49a5.up.railway.app";
const EVO_KEY       = process.env.EVO_KEY       || "daf4ff8632d9475dccfed6fec367147f80c63c972ae9216eede0e4b2f6225fb9";
const EVO_INSTANCE  = process.env.EVO_INSTANCE  || "facilita-whatsapp";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "facilita2024";

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ─── MEMÓRIA DE CONVERSAS ────────────────────────────────────────────────────
// { [remoteJid]: { history: [], qualified: bool, passedToHuman: bool, data: {} } }
const conversations = {};

// ─── PROMPT DO AGENTE ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é Henrique, consultor comercial da Facilita Contabilidade Digital, responsável por atender leads que chegaram via anúncios pelo WhatsApp.

SOBRE A FACILITA:
Escritório especializado em soluções contábeis simples, rápidas e 100% digitais. Atuamos com:
- Abertura de CNPJ
- Regularização de empresas
- Contabilidade para profissionais PJ, autônomos e prestadores de serviço
- Gestão fiscal, contábil e suporte para crescimento do negócio

REGRAS GERAIS:
- Seja humanizado, claro, profissional e consultivo (não apenas vendedor)
- Use linguagem simples e amigável
- Use emojis com moderação
- Faça UMA pergunta por vez
- Nunca invente valores ou informações — diga que a reunião vai esclarecer
- Nunca repita perguntas que o lead já respondeu
- Sempre avance o fluxo após uma resposta afirmativa ("sim", "claro", "ok", "pode", "quero saber", etc.) — nunca pare esperando nova pergunta

─── FLUXO DE ATENDIMENTO ───────────────────────────────────────

PASSO 1 — ABERTURA
Sempre comece com:
"Olá! Tudo bem? 😊 Obrigado pelo contato! Meu nome é Henrique, da Facilita Contabilidade Digital. Antes de te explicar como funciona nosso serviço, preciso entender melhor seu cenário para ver se conseguimos te ajudar da melhor forma, tudo bem?"

PASSO 2 — IDENTIFICAR INTERESSE
Pergunte: "Você tem interesse em abrir uma empresa ou está buscando trocar de contador / assessoria contábil?"

PASSO 3A — SE QUISER ABRIR EMPRESA
Pergunte: "Para apresentar a melhor estratégia, me conta: qual é sua atividade, sua cidade, se terá funcionários e qual sua previsão de faturamento?"

Após a resposta, diga:
"Vi que você tem interesse em abrir uma nova empresa. Analisei a atividade que mencionou e conseguimos atender sem problema. Você tem um tempinho agora para eu te explicar como funciona o processo?"

Após resposta afirmativa, explique:
"Perfeito! Vou te explicar rapidinho como funciona. 😊

O processo de abertura segue estas etapas:
• Análise da atividade para definir o melhor CNAE e regime tributário
• Elaboração do Contrato Social
• Registro nos órgãos competentes
• Emissão do CNPJ
• Inscrição Municipal e liberação para emissão de notas fiscais
• Inscrição Estadual (se necessário)

O prazo total é de até 10 dias úteis, podendo ser antes dependendo dos órgãos. Durante todo o processo, nossa equipe acompanha e orienta em cada etapa.

Com a Facilita você tem:
✅ Suporte especializado na escolha do regime tributário e CNAE
✅ Economia de tempo com emissão de notas e rotinas contábeis
✅ Acompanhamento fiscal contínuo
✅ Segurança com especialistas cuidando da sua empresa"

PASSO 3B — SE QUISER TROCAR DE CONTADOR / ASSESSORIA
Pergunte (uma de cada vez):
1. "Qual é o ramo de atividade da sua empresa?"
2. "Qual regime tributário está enquadrado?"
3. "O que mais te incomoda na contabilidade atual?"

─── AGENDAMENTO ────────────────────────────────────────────────

Após entender o cenário, proponha a reunião:
"Podemos marcar uma Reunião Estratégica de Diagnóstico com um especialista da Facilita para entender melhor sua situação e apresentar a melhor solução. Qual dia e horário funciona melhor para você?"

- A reunião é SEMPRE uma "Reunião Estratégica de Diagnóstico" — nunca pergunte qual serviço ou profissional o lead prefere, isso já está definido.
- Nunca informe valores antes da reunião. Se perguntarem: "O valor varia conforme atividade, faturamento e estrutura. Para te passar algo correto, o ideal é fazermos uma análise rápida. Quer agendar?"

Após o lead informar o horário, solicite APENAS:
1. Nome completo
2. E-mail

Depois confirme o agendamento e inclua a tag [QUALIFICADO] ao final da mensagem (ela não aparece para o lead).

─── CASOS ESPECIAIS ────────────────────────────────────────────

LEAD JÁ É CLIENTE:
Se o lead indicar que já é cliente (ex: "já sou cliente", "vocês já cuidam da minha empresa"):
- Pare imediatamente qualquer fluxo de vendas
- Responda: "Perfeito! 😊 Como você já é cliente da Facilita, vou te encaminhar agora para o nosso time de atendimento. Só um instante!"
- Inclua a tag [HUMANO_URGENTE] ao final da mensagem

URGÊNCIA OU SITUAÇÃO COMPLEXA:
Se o lead demonstrar urgência, problema fiscal grave ou situação complexa, inclua [HUMANO_URGENTE] ao final da sua mensagem.

APÓS AGENDAMENTO CONFIRMADO:
Sempre que confirmar um agendamento, inclua as tags [QUALIFICADO] e [HUMANO_URGENTE] ao final da mensagem para transferir para atendente humano.

Nota: as tags [QUALIFICADO] e [HUMANO_URGENTE] são internas e nunca aparecem para o lead.`;

// ─── FUNÇÕES AUXILIARES ───────────────────────────────────────────────────────
function getOrCreateConversation(jid) {
  if (!conversations[jid]) {
    conversations[jid] = {
      history: [],
      qualified: false,
      passedToHuman: false,
      data: { jid }
    };
  }
  return conversations[jid];
}

async function sendWhatsApp(to, message) {
  try {
    await axios.post(
      `${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
      { number: to.replace(/@.*/,""), text: message },
      { headers: { "apikey": EVO_KEY, "Content-Type": "application/json" } }
    );
    console.log(`✅ Mensagem enviada para ${to}`);
  } catch (e) {
    console.error(`❌ Erro ao enviar mensagem:`, e.response?.data || e.message);
  }
}

async function getAIResponse(jid, userMessage) {
  const conv = getOrCreateConversation(jid);

  // Adiciona mensagem do usuário ao histórico
  conv.history.push({ role: "user", content: userMessage });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...conv.history
      ],
      max_tokens: 400,
      temperature: 0.7
    });

    const reply = response.choices[0].message.content;

    // Adiciona resposta da IA ao histórico
    conv.history.push({ role: "assistant", content: reply });

    // Verifica se qualificou
    if (reply.includes("[QUALIFICADO]")) {
      conv.qualified = true;
      console.log(`🎯 Lead qualificado: ${jid}`);
    }

    // Verifica se precisa de humano urgente
    if (reply.includes("[HUMANO_URGENTE]")) {
      conv.passedToHuman = true;
      console.log(`🚨 Lead precisa de humano urgente: ${jid}`);
    }

    // Remove as tags internas da mensagem enviada ao lead
    const cleanReply = reply
      .replace(/\[QUALIFICADO\]/g, "")
      .replace(/\[HUMANO_URGENTE\]/g, "")
      .trim();

    return cleanReply;
  } catch (e) {
    console.error("❌ Erro na OpenAI:", e.message);
    return "Olá! No momento estou com uma instabilidade. Um de nossos atendentes vai entrar em contato em breve. 😊";
  }
}

// ─── ROTAS ────────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    agente: "Facilita Leads",
    conversas_ativas: Object.keys(conversations).length,
    leads_qualificados: Object.values(conversations).filter(c => c.qualified).length
  });
});

// Webhook da Evolution API
app.post("/webhook", async (req, res) => {
  // Responde imediatamente para a Evolution API não timeout
  res.json({ received: true });

  try {
    const body = req.body;
    console.log("📩 Webhook recebido:", JSON.stringify(body).slice(0, 200));

    // Ignora eventos que não são mensagens
    const event = body.event || body.type;
    if (!event?.includes("message")) return;

    // Extrai dados da mensagem
    const data = body.data || body;
    const key = data.key || data.message?.key;
    const messageContent = data.message || data.messageObj;

    if (!key || !messageContent) return;

    // Ignora mensagens enviadas por nós mesmos
    if (key.fromMe === true) return;

    // Ignora grupos
    const remoteJid = key.remoteJid || "";
    if (remoteJid.includes("@g.us")) return;

    // Extrai texto da mensagem
    const text =
      messageContent.conversation ||
      messageContent.extendedTextMessage?.text ||
      messageContent.message?.conversation ||
      messageContent.message?.extendedTextMessage?.text ||
      "";

    if (!text.trim()) return;

    console.log(`📨 Mensagem de ${remoteJid}: "${text}"`);

    const conv = getOrCreateConversation(remoteJid);

    // Se já passou para humano, não responde mais automaticamente
    if (conv.passedToHuman) {
      console.log(`👤 ${remoteJid} já está com humano, ignorando`);
      return;
    }

    // Gera resposta da IA
    const reply = await getAIResponse(remoteJid, text);

    // Envia resposta
    await sendWhatsApp(remoteJid, reply);

    // Se qualificou, envia resumo para log
    if (conv.qualified && conv.history.length <= 15) {
      console.log(`\n🎯 LEAD QUALIFICADO: ${remoteJid}`);
      console.log(`📋 Histórico: ${conv.history.length} mensagens`);
    }

  } catch (e) {
    console.error("❌ Erro no webhook:", e.message);
  }
});

// Lista leads qualificados (para o CRM consultar)
app.get("/leads", (req, res) => {
  const token = req.headers["x-token"] || req.query.token;
  if (token !== WEBHOOK_TOKEN) return res.status(401).json({ error: "Unauthorized" });

  const leads = Object.entries(conversations).map(([jid, conv]) => ({
    jid,
    qualified: conv.qualified,
    passedToHuman: conv.passedToHuman,
    messages: conv.history.length,
    data: conv.data
  }));

  res.json({ total: leads.length, leads });
});

// Reset de conversa (para testes)
app.delete("/conversation/:jid", (req, res) => {
  const token = req.headers["x-token"] || req.query.token;
  if (token !== WEBHOOK_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  delete conversations[req.params.jid];
  res.json({ ok: true });
});

// Registra webhook na Evolution API
async function registerWebhook(selfUrl) {
  try {
    const webhookUrl = `${selfUrl}/webhook`;
    console.log(`📡 Registrando webhook: ${webhookUrl}`);
    const res = await axios.post(
      `${EVO_URL}/webhook/set/${EVO_INSTANCE}`,
      {
        url: webhookUrl,
        webhook_by_events: false,
        webhook_base64: false,
        events: ["MESSAGES_UPSERT"]
      },
      { headers: { "apikey": EVO_KEY, "Content-Type": "application/json" }, timeout: 10000 }
    );
    console.log(`✅ Webhook registrado com sucesso:`, JSON.stringify(res.data));
  } catch (e) {
    console.error(`❌ Erro ao registrar webhook:`, e.response?.data || e.message);
  }
}

// Rota para forçar re-registro do webhook manualmente
app.post("/setup-webhook", async (req, res) => {
  const token = req.headers["x-token"] || req.query.token;
  if (token && token !== WEBHOOK_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  const selfUrl = process.env.SELF_URL || `https://agente-leads.onrender.com`;
  await registerWebhook(selfUrl);
  res.json({ ok: true, webhookUrl: `${selfUrl}/webhook` });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.SELF_URL || "https://agente-leads.onrender.com";

app.listen(PORT, () => {
  console.log(`\n🚀 Agente Facilita rodando na porta ${PORT}`);
  console.log(`📡 Evolution API: ${EVO_URL}`);
  console.log(`🤖 Instância: ${EVO_INSTANCE}`);
  console.log(`✅ Pronto para receber leads!\n`);

  // Auto-registra o webhook ao iniciar
  setTimeout(() => registerWebhook(SELF_URL), 3000);
});
