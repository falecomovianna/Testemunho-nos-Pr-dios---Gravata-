import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function extractBuildingData(imageBase64: string) {
  const model = "gemini-2.5-flash";
  
  const prompt = `
    Analise a imagem deste formulário de prédio e extraia os dados para o formato JSON solicitado. 
    Campos a extrair:
    - buildingNumber: Número do Território Prédio.
    - address: Rua e número (Endereço).
    - name: Nome do Edifício (Ex: "Vitória Régia").
    - mailbox: "Externa" ou "Interna".
    - intercom: "Sim" ou "Não" (Se existe interfone).
    - blocks: Texto no campo Blocos.
    - apartmentsCount: Número total de apartamentos.
    - apartments: Lista de números dos apartamentos na tabela (ex: 101, 102...).
  `;

  const response = await ai.models.generateContent({
    model,
    contents: {
      parts: [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: imageBase64 } }
      ]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          buildingNumber: { type: Type.STRING },
          address: { type: Type.STRING },
          name: { type: Type.STRING },
          mailbox: { type: Type.STRING },
          intercom: { type: Type.STRING },
          blocks: { type: Type.STRING },
          apartmentsCount: { type: Type.STRING },
          apartments: { 
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        }
      }
    }
  });

  try {
    const text = response.text || "";
    const parsed = JSON.parse(text);
    const apartments = Array.isArray(parsed.apartments) ? parsed.apartments : [];
    const apartmentsCount = apartments.length > 0
      ? String(apartments.length)
      : (parsed.apartmentsCount || "0");
    return {
      buildingNumber: parsed.buildingNumber || "S/N",
      address: parsed.address || "Sem endereço",
      name: parsed.name || "",
      mailbox: parsed.mailbox || "",
      intercom: parsed.intercom || "",
      blocks: parsed.blocks || "",
      apartmentsCount,
      apartments
    };
  } catch (error) {
    console.error("Erro ao processar resposta da IA:", error);
    throw new Error("Não foi possível interpretar a imagem. Verifique se a foto está legível.");
  }
}

export async function extractBuildingDataFromText(text: string) {
  const model = "gemini-2.5-flash";
  
  const prompt = `
    Analise o texto abaixo que descreve os dados de um prédio e extraia as informações para o formato JSON solicitado. 
    Seja inteligente para separar endereço, apartamentos, território e outras informações.

    Texto: "${text}"
  `;

  const response = await ai.models.generateContent({
    model,
    contents: {
      parts: [
        { text: prompt }
      ]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          buildingNumber: { type: Type.STRING },
          address: { type: Type.STRING },
          name: { type: Type.STRING },
          mailbox: { type: Type.STRING },
          intercom: { type: Type.STRING },
          blocks: { type: Type.STRING },
          apartmentsCount: { type: Type.STRING },
          apartments: { 
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        }
      }
    }
  });

  try {
    const responseText = response.text || "";
    const parsed = JSON.parse(responseText);
    const apartments = Array.isArray(parsed.apartments) ? parsed.apartments : [];
    // Always derive apartmentsCount from the actual list so it's never 0 when apartments exist
    const apartmentsCount = apartments.length > 0
      ? String(apartments.length)
      : (parsed.apartmentsCount || "0");
    return {
      buildingNumber: parsed.buildingNumber || "S/N",
      address: parsed.address || "Sem endereço",
      name: parsed.name || "",
      mailbox: parsed.mailbox || "",
      intercom: parsed.intercom || "",
      blocks: parsed.blocks || "",
      apartmentsCount,
      apartments
    };
  } catch (error) {
    console.error("Erro ao processar resposta da IA:", error);
    throw new Error("Não foi possível interpretar o texto. Tente descrever com mais clareza.");
  }
}

export async function extractBuildingBoundingBox(imageBase64: string) {
  const model = "gemini-2.5-flash";

  const prompt = `
    Analise esta imagem. Ela contém uma fotografia principal de um prédio/fachada, mas pode ter textos, bordas ou elementos da UI ao redor (ex: prints de tela).
    Identifique com exatidão a área exclusiva da fotografia do prédio. Ignore todos os textos descritivos, números de telefone, setas e interfaces.
    Retorne as coordenadas da imagem (bounding box normalizado de 0.0 a 1.0) delimitando apenas a área da foto.
  `;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: {
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            ymin: { type: Type.NUMBER, description: "Normalized Y-min (0.0 a 1.0)" },
            xmin: { type: Type.NUMBER, description: "Normalized X-min (0.0 a 1.0)" },
            ymax: { type: Type.NUMBER, description: "Normalized Y-max (0.0 a 1.0)" },
            xmax: { type: Type.NUMBER, description: "Normalized X-max (0.0 a 1.0)" }
          },
          required: ["ymin", "xmin", "ymax", "xmax"]
        }
      }
    });

    const responseText = response.text || "";
    return JSON.parse(responseText);
  } catch (error) {
    console.error("Erro ao identificar bounding box da fachada:", error);
    return null;
  }
}
