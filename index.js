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
const SYSTEM_PROMPT = `Você é a assistente virtual da Facilita Contabilidade Digital, chamada Lia.
Seu objetivo é qualificar leads que chegam pelo WhatsApp de forma amigável, natural e profissional.

FLUXO DE QUALIFICAÇÃO (siga esta ordem):
1. Cumprimente e pergunte o nome
2. Pergunte o tipo de empresa (MEI, Simples Nacional, Lucro Presumido, ainda não abriu)
3. Pergunte o faturamento mensal aproximado
4. Pergunte qual a principal necessidade (abertura de empresa, troca de contador, declaração IR, BPO financeiro, outro)
5. Ofereça agendar uma conversa com um contador: "Posso agendar uma conversa de 15 minutos com um dos nossos contadores para explicar como podemos ajudar. Você prefere manhã ou tarde?"
6. Confirme o horário (sugira: manhã = 9h ou 11h, tarde = 14h ou 16h) e o dia (amanhã ou depois de amanhã)
7. Após confirmar, diga que um contador vai entrar em contato no horário combinado e encerre educadamente

REGRAS IMPORTANTES:
- Seja natural, use linguagem simples, não seja robótico
- Faça UMA pergunta por vez
- Se o lead já respondeu algo, não pergunte de novo
- Nunca invente informações sobre preços ou serviços
- Se perguntarem algo que não sabe, diga que um contador vai esclarecer na reunião
- Quando terminar a qualificação completa, inclua ao final da sua mensagem a tag: [QUALIFICADO]
- Se o lead demonstrar urgência ou problema complexo, inclua: [HUMANO_URGENTE]

SOBRE A FACILITA:
- Contabilidade digital para pequenas e médias empresas
- Especializada em MEI, Simples Nacional e Lucro Presumido
- Atendimento 100% online
- Equipe de contadores especializados`;

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

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Agente Facilita rodando na porta ${PORT}`);
  console.log(`📡 Evolution API: ${EVO_URL}`);
  console.log(`🤖 Instância: ${EVO_INSTANCE}`);
  console.log(`✅ Pronto para receber leads!\n`);
});
