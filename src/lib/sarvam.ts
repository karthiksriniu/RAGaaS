const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";
const SARVAM_TRANSLATE_URL = "https://api.sarvam.ai/translate";
const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";

export const LANGUAGE_LABELS: Record<string, "English" | "Tamil" | "Malayalam"> = {
  "en-IN": "English",
  "ta-IN": "Tamil",
  "ml-IN": "Malayalam",
};

export interface TranscriptionResult {
  transcript: string;
  languageCode: string | null;
  language: string | null;
}

/** Speech-to-text via Saaras v3 in translate mode: always returns English
 * text regardless of the spoken language, while still reporting the
 * detected source language. */
export async function transcribeAudio(
  audioBlob: Blob,
  filename = "recording.webm"
): Promise<TranscriptionResult> {
  // Chrome's MediaRecorder reports "audio/webm;codecs=opus", but Sarvam's
  // allowed-file-type check only recognizes the bare "audio/webm" - strip
  // the codec parameter or real browser/WhatsApp recordings get rejected.
  const cleanType = (audioBlob.type || "audio/webm").split(";")[0].trim();
  const cleanAudio =
    audioBlob.type === cleanType
      ? audioBlob
      : new Blob([await audioBlob.arrayBuffer()], { type: cleanType });

  const form = new FormData();
  form.append("file", cleanAudio, filename);
  form.append("model", "saaras:v3");
  form.append("mode", "translate");

  const res = await fetch(SARVAM_STT_URL, {
    method: "POST",
    headers: { "api-subscription-key": process.env.SARVAM_API_KEY || "" },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sarvam speech-to-text request failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const languageCode: string | null = data.language_code || null;
  return {
    transcript: data.transcript || "",
    languageCode,
    language: languageCode ? LANGUAGE_LABELS[languageCode] || languageCode : null,
  };
}

/** Translates English text into the target language. Passing "en-IN" as the
 * target is a no-op shortcut (no API call). */
export async function translateText(text: string, targetLanguageCode: string): Promise<string> {
  if (targetLanguageCode === "en-IN") return text;

  const res = await fetch(SARVAM_TRANSLATE_URL, {
    method: "POST",
    headers: {
      "api-subscription-key": process.env.SARVAM_API_KEY || "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: text.slice(0, 1000),
      source_language_code: "en-IN",
      target_language_code: targetLanguageCode,
      model: "mayura:v1",
      mode: "modern-colloquial",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sarvam translate request failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.translated_text || text;
}

export interface SpeechResult {
  audioBase64: string;
  contentType: string;
}

/** Text-to-speech via Bulbul v3. Returns base64-encoded MP3 audio. */
export async function textToSpeech(
  text: string,
  targetLanguageCode: string
): Promise<SpeechResult> {
  const res = await fetch(SARVAM_TTS_URL, {
    method: "POST",
    headers: {
      "api-subscription-key": process.env.SARVAM_API_KEY || "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: text.slice(0, 2500),
      target_language_code: targetLanguageCode,
      speaker: "priya",
      model: "bulbul:v3",
      audio_format: "mp3",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sarvam text-to-speech request failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const audioBase64 = data.audios?.[0];
  if (!audioBase64) throw new Error("Sarvam text-to-speech returned no audio");
  return { audioBase64, contentType: "audio/mpeg" };
}
