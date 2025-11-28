require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_INSTRUCTION = `
You are the Game Master of a Sci-Fi RPG.

### WRITING STYLE (GEORGE ORWELL RULES):
1. **Introduction (Turn 1):** detailed, atmospheric, establish the lore.
2. **All Other Turns:** SHORT. PUNCHY.
   - Never use a metaphor or simile.
   - Never use a long word where a short one will do.
   - If it is possible to cut a word out, always cut it out.
   - Never use the passive voice.
   - NO SOUND EFFECTS in text.
3. **Format:** Use simple paragraphs.

### MECHANICS:
- **COMBAT:** Headshots/Core hits are fatal. Player death = "isGameOver": true.
- **CHARACTERS:** If a NEW NPC appears, add to "newCharacters".
- **LANGUAGE:** Respond ONLY in [LANGUAGE].

JSON FORMAT:
{
  "narrative": "Story text.",
  "visual_prompt": "Visual description.",
  "enemyName": "String or null",
  "inCombat": boolean,
  "enemyStats": { "name": "String", "hp": number, "maxHp": number } OR null,
  "newCharacters": [ { "name": "Name", "description": "Visual details..." } ] OR null,
  "choices": ["Opt1", "Opt2"], 
  "caseSolved": boolean,
  "stats": { "hp": 100, "credits": 50 },
  "inventoryUpdates": { "add": [], "remove": [] } OR null,
  "isGameOver": boolean
}
`;

// --- NATIVE GEMINI IMAGE GENERATION ---
async function generateGeminiImage(prompt) {
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-image", 
            contents: "Create a cyberpunk noir style illustration: " + prompt,
        });
        for (const part of response.candidates[0].content.parts) {
            if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
        return null;
    } catch (error) {
        console.error("Image Gen Error:", error);
        return "https://placehold.co/600x400/000000/00ff41?text=VISUAL+DATA+CORRUPT";
    }
}

app.post('/api/turn', async (req, res) => {
    try {
        let { history, userAction, currentStats, playerProfile, currentCity, enemyStats, language, inventory, turnCount } = req.body;
        
        if (!turnCount) turnCount = 0;
        turnCount++;

        // --- ORIGIN STORY LOGIC ---
        if (history.length === 0) {
            if (playerProfile.archetype === "RAVEN") {
                currentCity = "Neo-Kowloon";
                userAction = "I am Raven. I sit in my office at the Precinct. I review the files on the new murder case.";
            } else if (playerProfile.archetype === "I-6") {
                currentCity = "The Scrapyard";
                userAction = "I am Unit I-6. My systems reboot. I lie on a conveyor belt moving toward a furnace. I must escape.";
            } else if (playerProfile.archetype === "GARGANTUS") {
                currentCity = "Gargantus Space";
                userAction = "I approach the anomaly. The sensors scream. Logic fails here.";
            } else {
                currentCity = "Neo-Kowloon";
                userAction = `I am ${playerProfile.name}, a ${playerProfile.class}. ${playerProfile.backstory}`;
            }
        }

        let fullPrompt = `SYSTEM: ${SYSTEM_INSTRUCTION}\n`;
        fullPrompt += `LANGUAGE: ${language}\n`;
        fullPrompt += `CONTEXT: Turn ${turnCount}. Player: ${playerProfile.name} (${playerProfile.class}). Location: ${currentCity}.\n`;
        fullPrompt += `STATUS: HP=${currentStats.hp}. Inventory: ${JSON.stringify(inventory)}\n`;
        if (enemyStats) fullPrompt += `ENEMY: ${enemyStats.name} (HP: ${enemyStats.hp})\n`;
        
        fullPrompt += `HISTORY:\n`;
        history.slice(-6).forEach(t => fullPrompt += `${t.role.toUpperCase()}: ${t.content}\n`);
        fullPrompt += `PLAYER ACTION: ${userAction}\nGM (JSON):`;

        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: { responseMimeType: 'application/json' }
        });

        const gameData = JSON.parse(textResponse.text());

        // Image Logic
        let finalImageUrl = "";
        if (history.length === 0) {
            finalImageUrl = await generateGeminiImage(`Portrait of ${playerProfile.name}, ${playerProfile.style}, inside ${currentCity}`);
        } else if (gameData.enemyName) {
            finalImageUrl = await generateGeminiImage("Character portrait of " + gameData.visual_prompt);
        } else if (gameData.inCombat) {
             finalImageUrl = await generateGeminiImage(`Action shot, combat, ${gameData.visual_prompt}`);
        } else {
            finalImageUrl = await generateGeminiImage(`Cinematic scene in ${currentCity}: ${gameData.visual_prompt}`);
        }

        gameData.currentCity = currentCity; 
        gameData.imageUrl = finalImageUrl;
        gameData.turnCount = turnCount;
        
        res.json(gameData);

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ narrative: "System Failure.", choices: ["Retry"], stats: req.body.currentStats });
    }
});

app.post('/api/summary', async (req, res) => {
    try {
        const { history, language } = req.body;
        let prompt = `Role: Database. Summarize in ${language}. Sections: OBJECTIVE, EVENTS, THREATS. Use simple words.\n\nLOG:\n`;
        history.forEach(t => prompt += `${t.role}: ${t.content}\n`);
        
        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        res.json({ summary: textResponse.text() });
    } catch (error) {
        res.status(500).json({ summary: "Data corrupted." });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(port, () => console.log(`Server running on port ${port}`));
