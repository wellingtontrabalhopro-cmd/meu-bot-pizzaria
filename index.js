
/**
 * --- SERVIDOR BACKEND (TWILIO VERSION) ---
 * Configurado para WhatsApp Sandbox
 */

import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());

// O Twilio envia dados como FORM URL ENCODED, não JSON puro no webhook
app.use(express.urlencoded({ extended: true })); 
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÕES ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER; // Ex: whatsapp:+14155238886

// Inicializa IA
let ai;
if (GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log("✅ IA Conectada (Google GenAI)");
} else {
    console.log("❌ IA desconectada: Falta GEMINI_API_KEY");
}

// Inicializa Twilio
let twilioClient;
if (TWILIO_SID && TWILIO_TOKEN && TWILIO_NUMBER) {
    twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
    console.log("✅ Twilio Conectado");
} else {
    console.log("❌ Twilio desconectado: Faltam variáveis de ambiente (SID, TOKEN ou PHONE)");
}

// --- MEMÓRIA ---
let globalSystemInstruction = "VOCÊ É UM ATENDENTE DE PIZZARIA.";
let globalKnowledgeBase = "Cardápio vazio.";
const chatHistory = {}; // Memória simples em tempo de execução
let orders = [];

// Função auxiliar para enviar msg via Twilio
async function sendWhatsApp(to, body) {
    if (!twilioClient) {
        console.error("Tentativa de envio sem Twilio configurado.");
        return;
    }
    
    // Garante formato whatsapp: no destinatário
    if (!to.startsWith('whatsapp:')) {
        to = `whatsapp:${to}`;
    }

    // Garante formato whatsapp: no remetente (variável de ambiente)
    let fromNumber = TWILIO_NUMBER;
    if (!fromNumber.startsWith('whatsapp:')) {
        fromNumber = `whatsapp:${fromNumber}`;
    }

    try {
        await twilioClient.messages.create({
            from: fromNumber,
            to: to,
            body: body
        });
        console.log(`📤 Enviado para ${to}`);
    } catch (error) {
        console.error("❌ Erro ao enviar Twilio:", error.message);
        throw error; // Repassa o erro para quem chamou tratar
    }
}

// --- ROTAS ---
app.get('/', (req, res) => {
    const statusTwilio = twilioClient ? "✅ ON" : "❌ OFF";
    const statusAI = ai ? "✅ ON" : "❌ OFF";
    res.send(`Bot Twilio Online 🍕<br>Status Twilio: ${statusTwilio}<br>Status Gemini: ${statusAI}`);
});

// Rota para o Frontend atualizar o 'Cérebro'
app.post('/admin/config', (req, res) => {
    globalSystemInstruction = req.body.systemInstruction || globalSystemInstruction;
    globalKnowledgeBase = req.body.knowledgeBase || globalKnowledgeBase;
    console.log("🧠 Configurações atualizadas via Frontend");
    res.json({ success: true });
});

// Rota para Cozinha ver pedidos
app.get('/admin/orders', (req, res) => res.json(orders));

// Rota para atualizar status do pedido
app.post('/admin/orders/:id/status', (req, res) => {
    const order = orders.find(o => o.id === req.params.id);
    if (order) {
        order.status = req.body.status;
        // Avisar cliente via WhatsApp
        if(order.customerPhone) {
             sendWhatsApp(order.customerPhone, `🔔 Atualização do seu pedido: *${req.body.status.toUpperCase()}*`);
        }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Pedido não encontrado" });
    }
});

// Rota de Teste (acionada pelo botão do App)
app.get('/teste-zap', async (req, res) => {
    const { celular } = req.query;
    if (!celular) return res.status(400).json({ error: "Falta celular" });
    
    // Formata numero (Remove caracteres não numéricos e garante 55 se for BR)
    let formatted = celular.replace(/\D/g, ''); 
    if (formatted.length >= 10 && !formatted.startsWith('55')) {
        formatted = '55' + formatted;
    }

    try {
        await sendWhatsApp(formatted, "✅ Teste do Servidor com Twilio: Conexão OK!");
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- WEBHOOK (ONDE O TWILIO BATE) ---
app.post('/webhook', async (req, res) => {
    // O Twilio manda 'From' (quem enviou) e 'Body' (texto)
    const incomingMsg = req.body.Body;
    const from = req.body.From; // Formato: whatsapp:+5511999999999

    if (!incomingMsg || !from) return res.sendStatus(200);

    console.log(`📩 De ${from}: ${incomingMsg}`);

    // Inicializa histórico
    if (!chatHistory[from]) chatHistory[from] = [];
    
    // Adiciona msg do usuario
    chatHistory[from].push({ role: 'user', parts: [{ text: incomingMsg }] });

    try {
        if (!ai) throw new Error("IA não configurada");

        // Gera resposta na IA
        const result = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: chatHistory[from],
            config: {
                systemInstruction: globalSystemInstruction + "\n\n" + globalKnowledgeBase
            }
        });

        let responseText = result.text;

        // --- LÓGICA DE PEDIDO ---
        const orderRegex = /!!!ORDER_START!!!([\s\S]*?)!!!ORDER_END!!!/;
        const match = responseText.match(orderRegex);

        if (match && match[1]) {
            try {
                const jsonStr = match[1];
                const orderData = JSON.parse(jsonStr);

                // Salva na memória
                const newOrder = {
                    id: `TW-${Date.now().toString().slice(-4)}`,
                    customerName: orderData.nome_cliente || "Cliente WhatsApp",
                    customerPhone: from, // Guarda o ID do Twilio
                    address: orderData.endereco_completo,
                    items: orderData.itens || [],
                    total: orderData.total_numerico || 0,
                    paymentMethod: orderData.forma_pagamento,
                    changeNeeded: orderData.troco_para,
                    status: 'pending',
                    timestamp: Date.now()
                };
                
                orders.unshift(newOrder);
                console.log("🍕 Novo Pedido Registrado:", newOrder.id);

                // Remove o bloco JSON da mensagem que vai pro cliente
                responseText = responseText.replace(orderRegex, '').trim();
                responseText += "\n\n✅ *Seu pedido foi enviado para a cozinha!*"
            } catch (e) {
                console.error("Erro ao processar JSON do pedido:", e);
            }
        }

        // Salva resposta no histórico
        chatHistory[from].push({ role: 'model', parts: [{ text: responseText }] });

        // Envia resposta via Twilio Client (Async)
        await sendWhatsApp(from, responseText);

    } catch (error) {
        console.error("Erro no processamento:", error);
        await sendWhatsApp(from, "Desculpe, tive um erro técnico momentâneo.");
    }

    // O Twilio espera um 200 OK rápido (TwiML vazio)
    res.type('text/xml');
    res.send('<Response></Response>');
});

app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
