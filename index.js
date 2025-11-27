
/**
 * --- SERVIDOR BACKEND (MODO API PRÓPRIA / WHATSAPP-WEB.JS / TWILIO) ---
 */

import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true })); 
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÕES ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Configuração TWILIO (Se estiver usando Twilio)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Configuração CUSTOM API (Se estiver usando whatsapp-web.js)
const CUSTOM_SEND_URL = process.env.CUSTOM_SEND_URL; 
const CUSTOM_API_KEY = process.env.CUSTOM_API_KEY; 

// Inicializa Twilio Client (se chaves existirem)
let twilioClient;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    try {
        const twilio = await import('twilio'); // Import dinâmico
        twilioClient = twilio.default(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        console.log("✅ Cliente Twilio inicializado");
    } catch (e) {
        console.error("⚠️ Erro ao carregar biblioteca Twilio:", e.message);
    }
}

// Inicializa IA
let ai;
if (GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log("✅ IA Conectada (Google GenAI)");
} else {
    console.log("❌ IA desconectada: Falta GEMINI_API_KEY");
}

// --- MEMÓRIA ---
let globalSystemInstruction = "VOCÊ É UM ATENDENTE DE PIZZARIA.";
let globalKnowledgeBase = "Cardápio vazio.";

// Inicia com um chat de exemplo para o usuário não ver tela vazia
const chatHistory = {
    "5511999999999": [
        { role: 'user', parts: [{ text: "(Exemplo) Olá, tem pizza de queijo?" }] },
        { role: 'model', parts: [{ text: "Olá! Sou o robô da pizzaria. Temos sim! A Média custa R$ 38,00." }] }
    ]
}; 
let orders = [];

// Função auxiliar para limpar telefone (remove @c.us, +, etc e deixa só numeros)
const sanitizePhone = (phone) => {
    if(!phone) return "unknown";
    return phone.replace(/\D/g, ''); // Remove tudo que não for número
};

// --- FUNÇÃO CENTRAL DE ENVIO (ROTEADOR) ---
async function sendWhatsApp(to, body) {
    const cleanPhone = sanitizePhone(to);
    
    // 1. Prioridade: TWILIO
    if (twilioClient && TWILIO_PHONE_NUMBER) {
        console.log(`📤 [Twilio] Enviando para ${cleanPhone}`);
        try {
            // Twilio precisa do formato whatsapp:+55...
            const from = TWILIO_PHONE_NUMBER.startsWith('whatsapp:') ? TWILIO_PHONE_NUMBER : `whatsapp:${TWILIO_PHONE_NUMBER}`;
            const toFormatted = `whatsapp:+${cleanPhone}`;
            
            await twilioClient.messages.create({
                from: from,
                to: toFormatted,
                body: body
            });
            console.log("✅ Enviado via Twilio");
            return;
        } catch (error) {
            console.error("❌ Erro Twilio:", error.message);
            throw error;
        }
    }

    // 2. Prioridade: API CUSTOMIZADA (Ngrok/Whatsapp-web.js)
    if (CUSTOM_SEND_URL) {
        console.log(`📤 [Custom API] Enviando para ${cleanPhone}`);
        try {
            const payload = {
                number: cleanPhone, 
                message: body,
                text: body 
            };
            const headers = { 'Content-Type': 'application/json' };
            if (CUSTOM_API_KEY) headers['Authorization'] = `Bearer ${CUSTOM_API_KEY}`;

            await axios.post(CUSTOM_SEND_URL, payload, { headers, timeout: 10000 });
            console.log(`✅ Enviado via API Customizada`);
            return;
        } catch (error) {
            console.error("❌ Erro API Customizada:", error.message);
            throw error;
        }
    }

    console.error("❌ NENHUM MÉTODO DE ENVIO CONFIGURADO (Sem Twilio e sem Custom URL)");
}

// --- ROTAS ---
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; padding: 20px;">
            <h1>🤖 Bot Online</h1>
            <ul>
                <li>IA: ${ai ? '✅ ON' : '❌ OFF'}</li>
                <li>Twilio: ${twilioClient ? '✅ ON' : '⚪ OFF'}</li>
                <li>Custom API: ${CUSTOM_SEND_URL ? '✅ ON' : '⚪ OFF'}</li>
                <li>Rota Chats: ✅ /admin/chats (Ativo)</li>
            </ul>
            <p>Use os endpoints <b>/webhook</b> para receber mensagens.</p>
        </div>
    `);
});

// Admin Config
app.post('/admin/config', (req, res) => {
    globalSystemInstruction = req.body.systemInstruction || globalSystemInstruction;
    globalKnowledgeBase = req.body.knowledgeBase || globalKnowledgeBase;
    console.log("🧠 Cérebro atualizado pelo Frontend");
    res.json({ success: true });
});

// Admin Orders
app.get('/admin/orders', (req, res) => res.json(orders));
app.post('/admin/orders/:id/status', (req, res) => {
    const order = orders.find(o => o.id === req.params.id);
    if (order) {
        order.status = req.body.status;
        if(order.customerPhone) {
             sendWhatsApp(order.customerPhone, `🔔 Status do pedido: *${req.body.status.toUpperCase()}*`)
                .catch(err => console.error("Falha notificação:", err.message));
        }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Pedido não encontrado" });
    }
});

// --- ROTA DE CHATS (Crucial para o Frontend) ---
app.get('/admin/chats', (req, res) => {
    console.log("🔍 Frontend requisitou lista de chats...");
    
    try {
        // Converte o objeto chatHistory em um array
        const chats = Object.keys(chatHistory).map(phoneKey => {
            const msgs = chatHistory[phoneKey];
            return {
                phone: phoneKey,
                messages: msgs,
                lastMessageTime: Date.now() 
            };
        });
        
        console.log(`📦 Retornando ${chats.length} chats ativos.`);
        res.json(chats);
    } catch (e) {
        console.error("Erro ao listar chats:", e);
        res.status(500).send("Erro interno ao listar chats");
    }
});

// Teste de Envio
app.get('/teste-zap', async (req, res) => {
    const { celular } = req.query;
    if (!celular) return res.status(400).json({ error: "Falta celular" });
    
    try {
        console.log("🧪 Teste iniciado via painel web...");
        await sendWhatsApp(celular, "✅ Teste de Conexão: AgentFlow -> Seu Zap");
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- WEBHOOK (Recebe msg do Twilio ou Custom API) ---
app.post('/webhook', async (req, res) => {
    let incomingMsg = "";
    let rawFrom = "";

    console.log("📥 Webhook Recebido:", JSON.stringify(req.body));

    // Lógica TWILIO
    if (req.body.Body && req.body.From) {
        incomingMsg = req.body.Body;
        rawFrom = req.body.From; // ex: whatsapp:+5511...
    } 
    // Lógica Custom API / Z-API
    else if (req.body.body || req.body.message || req.body.text) {
        incomingMsg = req.body.body || req.body.message || req.body.text;
        rawFrom = req.body.from || req.body.number || req.body.phone;
    }

    if (!incomingMsg || !rawFrom) {
        return res.status(400).send("Formato desconhecido.");
    }

    // Normaliza ID do usuário (Remove + e caracteres especiais para usar como chave)
    const userKey = sanitizePhone(rawFrom);

    // Cria histórico se não existir
    if (!chatHistory[userKey]) chatHistory[userKey] = [];
    
    // Salva msg do usuário
    chatHistory[userKey].push({ role: 'user', parts: [{ text: incomingMsg }] });

    try {
        if (!ai) throw new Error("IA offline (Falta API Key)");

        const result = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: chatHistory[userKey],
            config: { systemInstruction: globalSystemInstruction + "\n\n" + globalKnowledgeBase }
        });

        let responseText = result.text;
        
        // Processa Pedidos (JSON oculto)
        const orderRegex = /!!!ORDER_START!!!([\s\S]*?)!!!ORDER_END!!!/;
        const match = responseText.match(orderRegex);
        if (match && match[1]) {
            try {
                const orderData = JSON.parse(match[1]);
                const newOrder = {
                    id: `APP-${Date.now().toString().slice(-4)}`,
                    customerName: orderData.nome_cliente || "Cliente",
                    customerPhone: userKey,
                    address: orderData.endereco_completo,
                    items: orderData.itens || [],
                    total: orderData.total_numerico || 0,
                    paymentMethod: orderData.forma_pagamento,
                    changeNeeded: orderData.troco_para,
                    status: 'pending',
                    timestamp: Date.now()
                };
                orders.unshift(newOrder);
                responseText = responseText.replace(orderRegex, '').trim() + "\n\n✅ *Pedido confirmado!*";
            } catch(e) { console.error("Erro JSON Pedido:", e); }
        }

        // Salva resposta da IA no histórico
        chatHistory[userKey].push({ role: 'model', parts: [{ text: responseText }] });
        
        // Envia resposta de volta
        await sendWhatsApp(userKey, responseText);

    } catch (error) {
        console.error("❌ Erro ao processar IA:", error);
    }

    // Responde 200 OK para o webhook não reenviar
    // Twilio prefere XML TwiML, mas aceita 200 vazio se respondemos via API
    res.status(200).send('<Response></Response>'); 
});

app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
