
/**
 * --- SERVIDOR BACKEND (PARA RENDER.COM) ---
 * Salve este arquivo como 'index.js' no seu repositório.
 */

import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Habilita CORS para que seu Frontend React consiga falar com este Backend
app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3000;
const Z_API_INSTANCE = process.env.Z_API_INSTANCE; 
const Z_API_TOKEN = process.env.Z_API_TOKEN;       
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

// Validação Inicial
if (!GEMINI_API_KEY) console.error("❌ ERRO GRAVE: GEMINI_API_KEY não encontrada nas variáveis de ambiente!");
if (!Z_API_INSTANCE) console.error("❌ ERRO GRAVE: Z_API_INSTANCE não encontrada nas variáveis de ambiente!");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- ESTADO DO SISTEMA (MEMÓRIA) ---
let globalSystemInstruction = `
VOCÊ É UM ATENDENTE DE PIZZARIA.
Seu objetivo é anotar pedidos, tirar dúvidas e ser cortês.
Sempre verifique se o produto está disponível no cardápio abaixo.
Mantenha as respostas curtas, ideais para WhatsApp.
`;

let globalKnowledgeBase = `
=== CARDÁPIO ===
(Aguardando sincronização do App...)
`;

// Histórico de Conversas
const chatHistory = {};

// Pedidos Realizados
let orders = [];

// --- ROTAS DE ADMINISTRAÇÃO ---
app.post('/admin/config', (req, res) => {
    const { systemInstruction, knowledgeBase } = req.body;
    if (systemInstruction) globalSystemInstruction = systemInstruction;
    if (knowledgeBase) globalKnowledgeBase = knowledgeBase;
    console.log("✅ Configuração atualizada pelo Frontend!");
    res.json({ success: true, message: "Cérebro atualizado com sucesso." });
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
        // Se quiser avisar o cliente: sendWhatsAppMessage(orders[orderIndex].customerPhone, `Status: ${status}`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Order not found" });
    }
});

// --- ROTA HEALTH CHECK ---
app.get('/', (req, res) => {
    res.status(200).send('Bot Pizza Online 🍕');
});

// --- ROTA WEBHOOK (Z-API) ---
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    
    // Log para Debug na Render
    // console.log("📩 Webhook recebido:", JSON.stringify(data));

    // Validações básicas para ignorar status de entrega (ACK) ou mensagens próprias
    if (!data || !data.phone || data.fromMe || data.status) {
        return res.status(200).send('Ignored');
    }

    const userPhone = data.phone;
    
    // Tenta extrair texto de vários lugares possíveis (Texto, Botão, Lista, Legenda)
    const userText = 
        data.text?.message || 
        data.text || 
        data.caption || 
        data.buttonsResponseMessage?.message ||
        data.listResponseMessage?.message;

    if (!userText) {
        console.log(`⚠️ Mensagem sem texto recebida de ${userPhone}. Ignorando.`);
        return res.status(200).send('No text content');
    }

    console.log(`💬 Msg de ${userPhone}: "${userText}"`);

    // Inicializa histórico
    if (!chatHistory[userPhone]) {
        chatHistory[userPhone] = [];
    }

    // Adiciona msg do usuário ao histórico
    chatHistory[userPhone].push({ role: 'user', parts: [{ text: userText }] });

    // --- CHAMADA AO GEMINI ---
    const modelId = 'gemini-2.5-flash';
    const result = await ai.models.generateContent({
        model: modelId,
        contents: chatHistory[userPhone],
        config: {
            systemInstruction: globalSystemInstruction + "\n\n" + globalKnowledgeBase
        }
    });

    let botResponse = result.text;
    console.log(`🤖 Resposta do Bot: "${botResponse.substring(0, 50)}..."`);

    // --- DETECÇÃO DE PEDIDO (JSON) ---
    const orderBlockRegex = /!!!ORDER_START!!!([\s\S]*?)!!!ORDER_END!!!/;
    const match = botResponse.match(orderBlockRegex);

    if (match && match[1]) {
        try {
            const jsonStr = match[1].trim();
            const orderData = JSON.parse(jsonStr);
            
            const newOrder = {
                id: `ZAP-${Date.now().toString().slice(-4)}`,
                customerName: orderData.nome_cliente || userPhone,
                customerPhone: userPhone,
                address: orderData.endereco_completo || 'Retirada',
                items: orderData.items || orderData.itens || [],
                total: typeof orderData.total_numerico === 'number' ? orderData.total_numerico : 0,
                paymentMethod: orderData.forma_pagamento || 'Dinheiro',
                changeNeeded: orderData.troco_para,
                status: 'pending',
                timestamp: Date.now()
            };

            orders.unshift(newOrder); 
            console.log("🍕 NOVO PEDIDO SALVO:", newOrder.id);

            // Limpa o JSON da resposta para o usuário não ver
            botResponse = botResponse.replace(orderBlockRegex, '').trim();
            
            if (!botResponse.includes("confirmado")) {
                botResponse += "\n\n✅ *Pedido enviado para a cozinha!*";
            }
        } catch (e) {
            console.error("❌ Erro ao ler JSON do pedido:", e);
        }
    }

    // Atualiza histórico com a resposta do bot
    chatHistory[userPhone].push({ role: 'model', parts: [{ text: botResponse }] });

    // Envia para o WhatsApp
    await sendWhatsAppMessage(userPhone, botResponse);

    res.status(200).send('OK');

  } catch (error) {
    console.error('❌ ERRO NO WEBHOOK:', error);
    // Retorna 200 para a Z-API não ficar tentando reenviar infinitamente em caso de erro interno
    res.status(200).send('Error handled'); 
  }
});

async function sendWhatsAppMessage(phone, message) {
    if (!Z_API_INSTANCE || !Z_API_TOKEN) {
        console.error("❌ Não consigo enviar msg: Falta Z_API_INSTANCE ou Z_API_TOKEN");
        return;
    }
    
    const url = `https://api.z-api.io/instances/${Z_API_INSTANCE}/token/${Z_API_TOKEN}/send-text`;
    
    try {
        await axios.post(url, { phone, message });
        console.log("✅ Mensagem enviada para o WhatsApp!");
    } catch (err) {
        console.error('❌ Erro Z-API:', err.response ? err.response.data : err.message);
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
