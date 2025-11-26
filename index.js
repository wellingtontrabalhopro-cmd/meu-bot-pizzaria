
/**
 * --- SERVIDOR BACKEND (PARA RENDER.COM) ---
 * Versão adaptada para TWILIO
 */

import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const app = express();

// Habilita CORS
app.use(cors());

// Twilio envia dados como application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
// Mantemos JSON para as rotas de admin do React
app.use(express.json());

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3000;

// Limpeza de espaços em branco nas chaves
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null; 
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.trim() : null;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ? process.env.TWILIO_AUTH_TOKEN.trim() : null;
// O número do Twilio (ex: whatsapp:+14155238886)
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER ? process.env.TWILIO_PHONE_NUMBER.trim() : null;

// --- VALIDAÇÃO INICIAL ---
console.log("--- INICIANDO BOT (TWILIO VERSION) ---");

if (!GEMINI_API_KEY) console.error("❌ ERRO: GEMINI_API_KEY faltando!");
else console.log("✅ GEMINI_API_KEY carregada.");

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error("❌ ERRO: Faltam variáveis do TWILIO (SID, TOKEN ou PHONE_NUMBER).");
} else {
    console.log("✅ Credenciais do Twilio carregadas.");
}

// Inicializa Clientes
let ai;
let twilioClient;

try {
    if (GEMINI_API_KEY) {
        ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        console.log("✅ Gemini inicializado.");
    }
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
        twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        console.log("✅ Cliente Twilio inicializado.");
    }
} catch (e) {
    console.error("❌ Erro na inicialização:", e);
}

// --- ESTADO (MEMÓRIA) ---
let globalSystemInstruction = `
VOCÊ É UM ATENDENTE DE PIZZARIA.
Seu objetivo é anotar pedidos, tirar dúvidas e ser cortês.
Mantenha as respostas curtas, ideais para WhatsApp.
`;

let globalKnowledgeBase = `
=== CARDÁPIO ===
(Aguardando sincronização do App...)
`;

const chatHistory = {};
let orders = [];

// --- ROTAS DE ADMINISTRAÇÃO (IGUAIS) ---
app.post('/admin/config', (req, res) => {
    const { systemInstruction, knowledgeBase } = req.body;
    if (systemInstruction) globalSystemInstruction = systemInstruction;
    if (knowledgeBase) globalKnowledgeBase = knowledgeBase;
    console.log("✅ Cérebro atualizado pelo Frontend.");
    res.json({ success: true });
});

app.get('/admin/orders', (req, res) => {
    res.json(orders);
});

app.post('/admin/orders/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const orderIndex = orders.findIndex(o => o.id === id);
    if (orderIndex !== -1) {
        orders[orderIndex].status = status;
        
        // Opcional: Avisar cliente via Twilio sobre a mudança de status
        // const customerPhone = orders[orderIndex].customerPhone; // já deve estar com 'whatsapp:+'
        // sendTwilioMessage(customerPhone, `🔔 Atualização do seu pedido: *${status.toUpperCase()}*`);
        
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Order not found" });
    }
});

// --- HELPER DE ENVIO TWILIO ---
async function sendTwilioMessage(to, body) {
    if (!twilioClient) {
        console.error("❌ Twilio Client não iniciado.");
        return;
    }
    
    // Garante formato whatsapp:+55...
    let formattedTo = to;
    if (!formattedTo.startsWith('whatsapp:')) {
        formattedTo = `whatsapp:${to}`;
    }

    try {
        await twilioClient.messages.create({
            from: TWILIO_PHONE_NUMBER, // Deve ser ex: 'whatsapp:+14155238886'
            to: formattedTo,
            body: body
        });
        console.log(`✅ Enviado para ${formattedTo}`);
    } catch (error) {
        console.error("❌ Erro ao enviar Twilio:", error.message);
    }
}

// --- ROTA DE TESTE ---
app.get('/teste-zap', async (req, res) => {
    const { celular } = req.query; // Ex: 5511999999999
    
    if (!twilioClient) return res.status(500).json({ success: false, error: "Twilio não configurado no servidor" });
    
    try {
        // Formata para o padrão do Twilio
        const formattedNum = `whatsapp:+${celular.replace(/\D/g, '')}`;
        
        await twilioClient.messages.create({
            from: TWILIO_PHONE_NUMBER,
            to: formattedNum,
            body: "🔔 Teste Bem Sucedido! Seu Bot está conectado ao Twilio."
        });
        res.json({ success: true });
    } catch (error) {
        console.error("Erro teste Twilio:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/test-keys', (req, res) => {
    res.json({
        gemini_ok: !!GEMINI_API_KEY,
        twilio_sid_ok: !!TWILIO_ACCOUNT_SID,
        twilio_token_ok: !!TWILIO_AUTH_TOKEN,
        twilio_number: TWILIO_PHONE_NUMBER || 'MISSING'
    });
});

app.get('/', (req, res) => res.send("Bot Twilio Online 🍕"));

// --- WEBHOOK TWILIO ---
app.post('/webhook', async (req, res) => {
    // O Twilio envia os dados no req.body (parsed pelo express.urlencoded)
    // Body: Mensagem
    // From: whatsapp:+5511999999999
    
    const incomingMsg = req.body.Body;
    const from = req.body.From; // Já vem com 'whatsapp:+'

    console.log(`📨 Twilio msg de ${from}: ${incomingMsg}`);

    if (!incomingMsg || !from) {
        return res.status(200).send('No content'); 
    }

    // Inicializa Histórico
    if (!chatHistory[from]) {
        chatHistory[from] = [];
    }
    chatHistory[from].push({ role: 'user', parts: [{ text: incomingMsg }] });

    if (!ai) return res.status(500).send('AI Error');

    try {
        // Gera resposta com Gemini
        const modelId = 'gemini-2.5-flash';
        const result = await ai.models.generateContent({
            model: modelId,
            contents: chatHistory[from],
            config: {
                systemInstruction: globalSystemInstruction + "\n\n" + globalKnowledgeBase
            }
        });

        let botResponse = result.text;
        
        // --- DETECÇÃO DE PEDIDO ---
        const orderBlockRegex = /!!!ORDER_START!!!([\s\S]*?)!!!ORDER_END!!!/;
        const match = botResponse.match(orderBlockRegex);

        if (match && match[1]) {
            try {
                const jsonStr = match[1].trim();
                const orderData = JSON.parse(jsonStr);
                
                // Remove prefixo whatsapp: para salvar no banco visualmente mais limpo
                const cleanPhone = from.replace('whatsapp:', '').replace('+', '');
                
                const newOrder = {
                    id: `TWI-${Date.now().toString().slice(-4)}`,
                    customerName: orderData.nome_cliente || "Cliente WhatsApp",
                    customerPhone: cleanPhone, 
                    address: orderData.endereco_completo || 'Retirada',
                    items: orderData.items || orderData.itens || [],
                    total: typeof orderData.total_numerico === 'number' ? orderData.total_numerico : 0,
                    paymentMethod: orderData.forma_pagamento || 'Dinheiro',
                    changeNeeded: orderData.troco_para,
                    status: 'pending',
                    timestamp: Date.now()
                };

                orders.unshift(newOrder);
                console.log("🍕 Pedido Twilio Salvo:", newOrder.id);

                botResponse = botResponse.replace(orderBlockRegex, '').trim();
                if (!botResponse.includes("confirmado")) {
                    botResponse += "\n\n✅ *Pedido confirmado!*";
                }

            } catch (e) {
                console.error("Erro parsing JSON order:", e);
            }
        }

        // Atualiza histórico
        chatHistory[from].push({ role: 'model', parts: [{ text: botResponse }] });

        // Responde ao Twilio
        // Podemos usar a biblioteca client.messages.create OU responder com TwiML (XML).
        // A biblioteca é mais flexível para logs.
        await sendTwilioMessage(from, botResponse);

        res.status(200).send('OK');

    } catch (error) {
        console.error("Erro processamento IA:", error);
        res.status(200).send('Error'); // Sempre retorne 200 pro Twilio não reenviar
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Twilio rodando na porta ${PORT}`);
});
