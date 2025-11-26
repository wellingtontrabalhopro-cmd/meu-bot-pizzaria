/**
 * --- SERVIDOR BACKEND (PARA RENDER.COM) ---
 * 
 * Este arquivo deve ser salvo como 'index.js' na sua pasta do servidor.
 * Você também precisará do arquivo 'package.json' na mesma pasta.
 */

const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
app.use(express.json());

// --- CONFIGURAÇÕES ---
// O Render injeta a porta automaticamente na variável process.env.PORT
const PORT = process.env.PORT || 3000;
const Z_API_INSTANCE = process.env.Z_API_INSTANCE; 
const Z_API_TOKEN = process.env.Z_API_TOKEN;       
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

// Inicializa o Gemini
// NOTA: Se der erro de API Key missing, verifique as Environment Variables no Dashboard da Render.
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- CÉREBRO DO BOT ---
// (Substitua isso pelo conteúdo copiado do botão "Copiar Configuração" no Frontend)
const SYSTEM_INSTRUCTION_BASE = `
VOCÊ É UM ATENDENTE DE PIZZARIA.
Seu objetivo é anotar pedidos, tirar dúvidas e ser cortês.
Sempre verifique se o produto está disponível no cardápio abaixo.
`;

const KNOWLEDGE_BASE_MENU = `
=== CARDÁPIO BÁSICO (ATUALIZE COM O DO APP) ===
- Pizza Calabresa: R$ 55,00
- Pizza Muçarela: R$ 50,00
- Coca Cola: R$ 15,00
`;

// Memória Volátil (Reinicia se o servidor reiniciar)
const chatHistory = {};

// --- ROTA HEALTH CHECK (Essencial para o Render não derrubar o app) ---
app.get('/', (req, res) => {
    res.status(200).send('Bot está online! 🚀');
});

// --- ROTA WEBHOOK (Configure esta URL na Z-API) ---
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;

    // Ignora status de entrega ou mensagens enviadas por mim
    if (!data || !data.phone || data.fromMe) {
        return res.status(200).send('Ignored');
    }

    const userPhone = data.phone;
    const userText = data.text?.message || data.text; 

    if (!userText) {
        return res.status(200).send('No text content');
    }

    console.log(`📩 Mensagem de ${userPhone}: ${userText}`);

    // Inicializa histórico
    if (!chatHistory[userPhone]) {
        chatHistory[userPhone] = [];
    }

    // Adiciona msg do usuário
    chatHistory[userPhone].push({ role: 'user', parts: [{ text: userText }] });

    // Gera resposta
    const model = 'gemini-2.5-flash';
    const result = await ai.models.generateContent({
        model: model,
        contents: chatHistory[userPhone],
        config: {
            systemInstruction: SYSTEM_INSTRUCTION_BASE + "\n\n" + KNOWLEDGE_BASE_MENU
        }
    });

    const botResponse = result.text;
    console.log(`🤖 Resposta: ${botResponse}`);

    // Salva resposta no histórico
    chatHistory[userPhone].push({ role: 'model', parts: [{ text: botResponse }] });

    // Envia para o WhatsApp
    await sendWhatsAppMessage(userPhone, botResponse);

    res.status(200).send('OK');

  } catch (error) {
    console.error('Erro no processamento:', error);
    // Sempre retorne 200 para o Webhook não ficar tentando reenviar infinitamente em caso de erro lógico
    res.status(200).send('Erro processado'); 
  }
});

async function sendWhatsAppMessage(phone, message) {
    if (!Z_API_INSTANCE || !Z_API_TOKEN) {
        console.error("Z-API Credentials missing");
        return;
    }
    
    const url = `https://api.z-api.io/instances/${Z_API_INSTANCE}/token/${Z_API_TOKEN}/send-text`;
    
    try {
        await axios.post(url, {
            phone: phone,
            message: message
        });
    } catch (err) {
        console.error('Falha ao enviar Z-API:', err.response?.data || err.message);
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});