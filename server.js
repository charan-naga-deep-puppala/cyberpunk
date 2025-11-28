require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenAI } = require("@google/genai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- WORLD DATA ---
const CITIES = {
    "Neo-Kowloon": "Rain. Neon. Noodle stands. Concrete.",
    "The Scrapyard": "Rust. Fire. Metal crushers.",
    "Solaris District": "Water. Glass. Strange lights.",
    "Magrathea Heights": "Gold. Fake sun. Clean air.",
    "Trantor Deep": "Metal walls. Pipes. Steam.",
    "The Zone": "Trees. Radiation. Silence.",
    "Ubik Reality": "Old houses. Fading colors. Decay.",
    "Gargantus Space": "Void. Stars. Impossible shapes."
};

// --- SYSTEM PROMPT ---
const SYSTEM_INSTRUCTION = `
You are the Game Master of a Sci-Fi RPG.

### WRITING RULES (STRICT ORWELLIAN):
1. **Never use a metaphor, simile, or figure of speech.**
2. **Never use a long word where a short one will do.**
3. **If it is possible to cut a word out, always cut it out.**
4. **Never use the passive where you can use the active.**
5. **Use everyday English.**
6. **NO SOUND EFFECTS.**
7. **FORMAT:** Write in clear paragraphs.

### STRUCTURE:
- **Turn 1 (Intro):** Detailed, atmospheric, establish lore.
- **Turns 2+:** Short. Punchy. Action/Reaction.

### MECHANICS:
1. **COMBAT:** Headshots/Core hits are fatal. Player death = "isGameOver": true.
2. **LOOTING:** - If player *sees* items but hasn't taken them: List in "availableItems".
   - If player *takes* an item (e.g. "I take the gun"): List in "inventoryUpdates" -> "add".
3. **CHARACTERS:** If a NEW NPC appears, add to "newCharacters".
4. **LANGUAGE:** Respond ONLY in [LANGUAGE].

JSON FORMAT:
{
  "narrative": "Story text.",
  "visual_prompt": "Visual description.",
  "enemyName": "String or null",
  "inCombat": boolean,
  "enemyStats": { "name": "String", "hp": number, "maxHp": number } OR null,
  "availableItems": [ { "name": "Item Name", "type": "weapons|items|memories", "description": "Short desc" } ] OR null,
  "newCharacters": [ { "name": "Name", "description": "Visual details..." } ] OR null,
  "choices": ["Opt1", "Opt2"], 
  "caseSolved": boolean,
  "stats": { "hp": 100, "credits": 50 },
  "inventoryUpdates": { "add": [], "remove": [] } OR null,
  "isGameOver": boolean
}
`;

// --- HELPER: ROBUST TEXT EXTRACTION ---
// This fixes the "text is not a function" error
function extractText(response) {
    if (typeof response.text === 'function') {
        return response.text();
    } else if (typeof response.text === 'string') {
        return response.text;
    } else if (response.candidates && response.candidates[0].content.parts[0].text) {
        return response.candidates[0].content.parts[0].text;
    }
    return "{}"; // Return empty JSON object string if failure
}

// --- IMAGE GENERATION ---
async function generateGeminiImage(prompt) {
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-image", 
            contents: "Create a cyberpunk noir style illustration, cinematic lighting, grainy image: " + prompt,
        });
        
        for (const part of response.candidates[0].content.parts) {
            if (part.inlineData) {
                return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            }
        }
        return null;
    } catch (error) {
        console.error("Image Gen Error:", error.message);
        return "https://placehold.co/600x400/000000/00ff41?text=VISUAL+DATA+CORRUPT";
    }
}

// --- MAIN TURN ENDPOINT ---
app.post('/api/turn', async (req, res) => {
    try {
        let { history, userAction, currentStats, playerProfile, currentCity, enemyStats, language, inventory, turnCount, maxTurns } = req.body;
        
        if (!turnCount) turnCount = 0;
        turnCount++;

        // Origin Story Logic
        if (history.length === 0) {
            turnCount = 1;
            if (playerProfile.archetype === "RAVEN") {
                currentCity = "Neo-Kowloon";
                userAction = "I am Raven. I sit in my office at the Precinct. I review the files on the new murder case.";
            } else if (playerProfile.archetype === "I-6") {
                currentCity = "The Scrapyard";
                userAction = "I am Unit I-6. My systems reboot. I lie on a conveyor belt moving toward a furnace. I must escape.";
            } else if (playerProfile.archetype === "GARGANTUS") {
                currentCity = "Gargantus Space";
                userAction = "I approach the anomaly. The ship sensors fail. I look out the viewport.";
            } else {
                currentCity = "Neo-Kowloon";
                userAction = `I am ${playerProfile.name}, a ${playerProfile.class}. ${playerProfile.backstory}`;
            }
        }

        const cityVibe = CITIES[currentCity] || "Cyberpunk City";
        
        let fullPrompt = `SYSTEM: ${SYSTEM_INSTRUCTION}\n`;
        fullPrompt += `LANGUAGE: ${language || 'English'}\n`;
        fullPrompt += `CONTEXT: Turn ${turnCount}/${maxTurns}. Player: ${playerProfile.name} (${playerProfile.class}). Location: ${currentCity} (${cityVibe}).\n`;
        fullPrompt += `STATUS: HP=${currentStats.hp}. Inventory: ${JSON.stringify(inventory)}\n`;
        if (enemyStats) fullPrompt += `ENEMY: ${enemyStats.name} (HP: ${enemyStats.hp})\n`;
        
        fullPrompt += `HISTORY:\n`;
        history.slice(-8).forEach(t => fullPrompt += `${t.role.toUpperCase()}: ${t.content}\n`);
        fullPrompt += `PLAYER ACTION: ${userAction}\nGM (JSON):`;

        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: { responseMimeType: 'application/json' }
        });

        // USE NEW EXTRACTOR
        const rawText = extractText(textResponse);
        const gameData = JSON.parse(rawText);

        // Forced Ending
        if (turnCount >= maxTurns && !gameData.isGameOver) {
            gameData.narrative += "\n\n[SYSTEM]: SIMULATION LIMIT REACHED. NARRATIVE CONCLUDED.";
            gameData.isGameOver = true;
        }

        // Image Logic
        let finalImageUrl = "";
        const isFirstTurn = history.length === 0;

        if (isFirstTurn) {
            finalImageUrl = await generateGeminiImage(`Pixel art portrait of ${playerProfile.name}, ${playerProfile.style}, 8-bit style, green monochrome background`);
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
        res.status(500).json({ narrative: "System Failure. Connection Lost.", choices: ["Retry"], stats: req.body.currentStats });
    }
});

// --- SUMMARY ENDPOINT ---
app.post('/api/summary', async (req, res) => {
    try {
        const { history, language } = req.body;
        let prompt = `Role: Database. Summarize in ${language}. Sections: OBJECTIVE, EVENTS, THREATS. Use simple words.\n\nLOG:\n`;
        history.forEach(t => prompt += `${t.role}: ${t.content}\n`);
        
        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        
        // USE NEW EXTRACTOR
        const summaryText = extractText(textResponse);
        res.json({ summary: summaryText });

    } catch (error) {
        console.error("Summary Error:", error);
        res.status(500).json({ summary: "Data corrupted." });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(port, () => console.log(`Server running on port ${port}`));
