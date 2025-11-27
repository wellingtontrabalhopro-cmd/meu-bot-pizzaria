
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

// --- DIAGNÓSTICO ---
let lastWebhookAttempt = "Nenhuma tentativa ainda";
let lastWebhookPayload = "Nenhum dado recebido ainda";
let webhookCount = 0;

// --- CONFIGURAÇÕES ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const CUSTOM_SEND_URL = process.env.CUSTOM_SEND_URL; 
const CUSTOM_API_KEY = process.env.CUSTOM_API_KEY; 

// Inicializa Twilio Client
let twilioClient;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    try {
        const twilio = await import('twilio'); 
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
}

// --- MEMÓRIA ---
let globalSystemInstruction = "VOCÊ É UM ATENDENTE DE PIZZARIA.";
let globalKnowledgeBase = "Cardápio vazio.";

// Chat Inicial de Exemplo
const chatHistory = {
    "5511999999999": [
        { role: 'user', parts: [{ text: "Este é um chat de exemplo." }] },
        { role: 'model', parts: [{ text: "Se você está vendo isso, o Frontend conectou no Backend! Agora precisamos fazer o Webhook funcionar." }] }
    ]
}; 
let orders = [];

// Função auxiliar para limpar telefone
const sanitizePhone = (phone) => {
    if(!phone) return "unknown";
    return phone.replace(/\D/g, ''); 
};

// --- FUNÇÃO DE ENVIO ---
async function sendWhatsApp(to, body) {
    const cleanPhone = sanitizePhone(to);
    
    // 1. Twilio
    if (twilioClient && TWILIO_PHONE_NUMBER) {
        console.log(`📤 [Twilio] Enviando para ${cleanPhone}`);
        try {
            const from = TWILIO_PHONE_NUMBER.startsWith('whatsapp:') ? TWILIO_PHONE_NUMBER : `whatsapp:${TWILIO_PHONE_NUMBER}`;
            const toFormatted = `whatsapp:+${cleanPhone}`;
            
            await twilioClient.messages.create({ from, to: toFormatted, body });
            return;
        } catch (error) {
            console.error("❌ Erro Twilio:", error.message);
            throw error;
        }
    }

    // 2. Custom API
    if (CUSTOM_SEND_URL) {
        console.log(`📤 [Custom API] Enviando para ${cleanPhone}`);
        try {
            // Tenta enviar em múltiplos formatos comuns para garantir compatibilidade
            await axios.post(CUSTOM_SEND_URL, { 
                number: cleanPhone,     // Formato 1
                phone: cleanPhone,      // Formato 2
                chatId: `${cleanPhone}@c.us`, // Formato whatsapp-web.js
                message: body, 
                text: body 
            });
            return;
        } catch (error) {
            console.error("❌ Erro API Customizada:", error.message);
            throw error;
        }
    }
}

// --- ROTAS ---
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: monospace; padding: 20px; line-height: 1.5;">
            <h1>🕵️ Painel de Detetive do Bot</h1>
            <div style="background: #f0f0f0; padding: 15px; border-radius: 8px;">
                <h3>📊 Status dos Webhooks</h3>
                <p><b>Total Recebidos:</b> ${webhookCount}</p>
                <p><b>Último Horário:</b> ${lastWebhookAttempt}</p>
                <p><b>Último Dado (Resumo):</b> ${lastWebhookPayload}</p>
            </div>
            <br/>
            <ul>
                <li>IA Google: ${ai ? '✅ CONECTADO' : '❌ DESCONECTADO'}</li>
                <li>API de Envio (Custom): ${CUSTOM_SEND_URL ? '✅ CONFIGURADA' : '⚪ NÃO CONFIGURADA'}</li>
            </ul>
            <hr/>
            <h3>Manual Rápido:</h3>
            <p>Seu código local deve fazer POST para: <b>${req.protocol}://${req.get('host')}/webhook</b></p>
            <p>JSON Esperado: <code>{ "number": "5511...", "message": "Olá" }</code></p>
        </div>
    `);
});

app.post('/admin/config', (req, res) => {
    globalSystemInstruction = req.body.systemInstruction || globalSystemInstruction;
    globalKnowledgeBase = req.body.knowledgeBase || globalKnowledgeBase;
    res.json({ success: true });
});

app.get('/admin/orders', (req, res) => res.json(orders));
app.post('/admin/orders/:id/status', (req, res) => {
    const order = orders.find(o => o.id === req.params.id);
    if (order) {
        order.status = req.body.status;
        if(order.customerPhone) {
             sendWhatsApp(order.customerPhone, `🔔 Status: *${req.body.status.toUpperCase()}*`).catch(e => console.error(e));
        }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Pedido não encontrado" });
    }
});

app.get('/admin/chats', (req, res) => {
    const chats = Object.keys(chatHistory).map(phoneKey => ({
        phone: phoneKey,
        messages: chatHistory[phoneKey],
        lastMessageTime: Date.now() 
    }));
    res.json(chats);
});

app.get('/teste-zap', async (req, res) => {
    const { celular } = req.query;
    if (!celular) return res.status(400).json({ error: "Falta celular" });
    try {
        await sendWhatsApp(celular, "✅ Teste de Conexão: O servidor está vivo!");
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- WEBHOOK ---
app.post('/webhook', async (req, res) => {
    webhookCount++;
    lastWebhookAttempt = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    
    console.log("📥 WEBHOOK RECEBIDO!");
    console.log("📦 Body Raw:", JSON.stringify(req.body));

    const body = req.body || {};
    
    // Tentativa Universal de ler a mensagem
    // Procura por message, text, body, content, etc.
    const incomingMsg = body.message || body.text || body.Body || body.body || body.content;
    
    // Tentativa Universal de ler o número
    // Procura por number, from, phone, sender, From
    const rawFrom = body.number || body.from || body.phone || body.sender || body.From || body.remoteJid;

    if (incomingMsg && rawFrom) {
        lastWebhookPayload = `Sucesso: ${rawFrom} enviou "${incomingMsg}"`;
        
        const userKey = sanitizePhone(rawFrom);
        if (!chatHistory[userKey]) chatHistory[userKey] = [];
        
        // Salva msg do usuário
        chatHistory[userKey].push({ role: 'user', parts: [{ text: incomingMsg }] });

        // Processa IA
        try {
            if (!ai) throw new Error("IA offline (Verifique GEMINI_API_KEY)");

            const result = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: chatHistory[userKey],
                config: { systemInstruction: globalSystemInstruction + "\n\n" + globalKnowledgeBase }
            });

            let responseText = result.text;
            
            // Processa Pedidos
            if (responseText.includes("!!!ORDER_START!!!")) {
                try {
                    const jsonBlock = responseText.split("!!!ORDER_START!!!")[1].split("!!!ORDER_END!!!")[0];
                    const orderData = JSON.parse(jsonBlock);
                    orders.unshift({
                        id: `APP-${Date.now().toString().slice(-4)}`,
                        customerName: orderData.nome_cliente || "Cliente",
                        customerPhone: userKey,
                        address: orderData.endereco_completo,
                        items: orderData.itens || [],
                        total: orderData.total_numerico || 0,
                        status: 'pending',
                        timestamp: Date.now()
                    });
                    responseText = responseText.replace(/!!!ORDER_START!!![\s\S]*?!!!ORDER_END!!!/, "").trim() + "\n\n✅ *Pedido Recebido!*";
                } catch(e) { console.error("Erro Pedido:", e); }
            }

            chatHistory[userKey].push({ role: 'model', parts: [{ text: responseText }] });
            await sendWhatsApp(userKey, responseText);

        } catch (error) {
            console.error("❌ Erro IA:", error);
            lastWebhookPayload += " | Erro IA: " + error.message;
        }
    } else {
        lastWebhookPayload = `Erro: JSON Inválido. Recebido: ${JSON.stringify(body)}`;
        console.error("❌ Erro: Campos não encontrados no JSON recebido.");
        return res.status(400).send("JSON Inválido: Envie { number, message }");
    }

    res.status(200).send({ status: 'received' }); 
});

// Inicialização: Cria dados falsos para visualização se estiver vazio
if (Object.keys(chatHistory).length === 0) {
    console.log("⚠️ Iniciando com dados de exemplo...");
    chatHistory["5511999999999"] = [
        { role: 'user', parts: [{ text: "Oi, o bot está on?" }] },
        { role: 'model', parts: [{ text: "Sim! Servidor Backend iniciado com sucesso. Aguardando mensagens reais..." }] }
    ];
}

app.listen(PORT, () => console.log(`✅ SERVIDOR INICIADO! DADOS DE EXEMPLO CARREGADOS.`));
