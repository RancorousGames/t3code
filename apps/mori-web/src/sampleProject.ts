import type { MoriCharacter, MoriGlossaryEntry, MoriProject, MoriRow, VersionEntry } from "./model.ts";

// Demo data for a first launch. It is saved like any project so the library has something to
// open, and it is clearly named as a demo.
type SampleLine = {
  id: string;
  file: string;
  speaker: string | null;
  en: string;
  dev?: string;
  ai?: string;
  tr?: string;
  locked?: boolean;
  hist?: { when: string; text: string }[];
  note?: string;
};

const SAMPLE_CHARACTERS: MoriCharacter[] = [
  { id: "ayla", name: "Ayla", role: "Protagonist · apprentice lamplighter", tone: "casual · 17 y/o", description: "一人称「私」。くだけた口調で語尾は「〜よ」「〜ってば」。年上には丁寧語に切り替える。" },
  { id: "bram", name: "Bram", role: "Ferryman · gruff but kind", tone: "rough", description: "一人称「俺」。べらんめえ調、「〜だぜ」「〜しちまった」。主人公は名前で呼び捨て。" },
  { id: "seraphine", name: "Seraphine", role: "Noble heiress · haughty, playful", tone: "わたくし · ですわ · お嬢様", description: "一人称「わたくし」。語尾は「〜ですわ」「〜ですこと」。主人公を「灯守さん」と呼ぶ。命令形は「お〜なさい」。" },
  { id: "narrator", name: "Narrator", role: "Narration", tone: "である調", description: "である調の地の文。硬くなりすぎないこと。" },
  { id: "system", name: "System", role: "UI text", tone: "UI", description: "簡潔に。ボタン名は体言止め。" },
];

const SAMPLE_GLOSSARY: MoriGlossaryEntry[] = [
  { id: "g1", en: "Hollowmere", jp: "ホロウミア", explanation: "Town name. Always katakana." },
  { id: "g2", en: "lamplighter", jp: "灯守", explanation: "Reading ひもり. Never ランプ係." },
  { id: "g3", en: "Ember", jp: "残り火", explanation: "" },
  { id: "g4", en: "lantern", jp: "ランタン", explanation: "Not ランプ — lamps are a different item." },
  { id: "g5", en: "Drowned Bell", jp: "沈み鐘", explanation: "" },
];

const SAMPLE_LINES: SampleLine[] = [
  { id: "ch1.001", file: "dialogue/chapter1.json", speaker: "narrator", en: "The fog came early to Hollowmere that year.", dev: "その年、霧は早くホロウミアに来た。", ai: "その年、ホロウミアには霧が早く訪れた。", tr: "その年、ホロウミアには早くも霧が立ちこめた。", locked: true },
  { id: "ch1.002", file: "dialogue/chapter1.json", speaker: "ayla", en: "Another night, another hundred lanterns.", dev: "また夜、また百のランタン。", ai: "また夜が来て、また百のランタン。", tr: "また夜が来た。今夜も灯すランプは百。" },
  { id: "ch1.003", file: "dialogue/chapter1.json", speaker: "bram", en: "You're late, {name}. The bell's already rung twice.", dev: "遅いぞ、{name}。鐘はもう二回鳴った。", ai: "遅いぞ、{name}。鐘はもう二度鳴ったぜ。", tr: "遅えぞ、{name}。鐘はもう二度鳴っちまった。" },
  { id: "ch1.004", file: "dialogue/chapter1.json", speaker: "ayla", en: "I know, I know! The Ember wouldn't catch.", ai: "わかってる、わかってるってば！ 残り火がなかなか点かなくて。" },
  { id: "ch1.005", file: "dialogue/chapter1.json", speaker: "bram", en: "Then hurry. Lady Seraphine is waiting by the Drowned Bell.", ai: "なら急げ。セラフィーヌ様が沈み鐘のそばでお待ちだ。" },
  { id: "ch1.006", file: "dialogue/chapter1.json", speaker: "seraphine", en: "A lamplighter who keeps a lady waiting? How terribly quaint.", dev: "女性を待たせる灯守？なんて古風な。", ai: "淑女を待たせる灯守ですって？ なんとも古風ですこと。" },
  {
    id: "ch1.007", file: "dialogue/chapter1.json", speaker: "seraphine",
    en: "Take this, lamplighter. {item_name} x{count} should last until dawn.",
    dev: "これを持って行け、灯守。{item_name}x{count}で夜明けまで持つ。",
    ai: "これをお持ちなさい、灯守さん。{item_name}が{count}個あれば、夜明けまでもちますわ。",
    tr: "これをお持ちなさい、灯守さん。{item_name}があれば夜明けまでもちますわ。",
    hist: [{ when: "Oct 14 · 21:40", text: "これを持っていきなさい、灯守。{item_name}で夜明けまではもつでしょう。" }],
    note: "Shown in a dialogue box with item icon — keep under 2 lines.",
  },
  { id: "ch1.008", file: "dialogue/chapter1.json", speaker: "ayla", en: "Thank you, my lady.\nI won't let a single one go out.", ai: "ありがとうございます、お嬢様。\nひとつだって消させません。" },
  { id: "ch1.009", file: "dialogue/chapter1.json", speaker: "narrator", en: "Somewhere beneath the black water, the Drowned Bell answered." },
  { id: "mk.001", file: "dialogue/market.json", speaker: "narrator", en: "The market smelled of wet rope and candle wax.", ai: "市場は濡れた縄と蝋燭の匂いがした。", tr: "市場には湿った縄と蝋の匂いが漂っていた。" },
  { id: "mk.002", file: "dialogue/market.json", speaker: null, en: "Lanterns! Three for a silver — they'll outlast your mother-in-law!", dev: "ランタン！銀貨一枚で三つ、姑より長持ち！", ai: "ランタンだよ！ 銀貨一枚で三つ、姑より長持ちするよ！" },
  { id: "mk.003", file: "dialogue/market.json", speaker: "ayla", en: "Do you have any Ember oil left?", ai: "残り火の油はまだありますか？", tr: "残り火の油、まだ残ってる？" },
  { id: "mk.004", file: "dialogue/market.json", speaker: "bram", en: "You're late, {name}. The bell's already rung twice.", tr: "遅えぞ、{name}。鐘はもう二度鳴っちまった。" },
  { id: "mk.005", file: "dialogue/market.json", speaker: "seraphine", en: "Buy whatever she needs. Send the bill to the Ashgrove estate.", ai: "彼女に必要なものは何でもお買いなさい。請求はアッシュグローブ家へ。" },
  { id: "ui.001", file: "ui/menus.csv", speaker: "system", en: "Save game", ai: "ゲームを保存", tr: "セーブ", locked: true },
  { id: "ui.002", file: "ui/menus.csv", speaker: "system", en: "Continue", ai: "続ける", tr: "つづきから" },
  { id: "ui.003", file: "ui/menus.csv", speaker: "system", en: "Lanterns lit: %d", ai: "点灯したランタン：%d", tr: "灯したランタン：%d" },
  { id: "ui.004", file: "ui/menus.csv", speaker: "system", en: "<color=#E6B96B>Ember</color> restored.", ai: "<color=#E6B96B>残り火</color>が回復した。" },
];

const SAMPLE_START = Date.parse("2026-10-14T20:00:00Z");

const toRow = (line: SampleLine, index: number): MoriRow => {
  const final = line.tr ?? "";
  const history: VersionEntry[] = (line.hist ?? []).map((entry, n) => ({
    text: entry.text, type: "curated", timestamp: SAMPLE_START + index * 60_000 + n,
  }));
  return {
    id: line.id,
    source: line.en,
    final,
    status: final ? "translated" : line.ai || line.dev ? "draft" : "pending",
    sourceFile: line.file,
    history,
    note: line.note ?? "",
    ...(line.dev ? { legacy: line.dev } : {}),
    ...(line.ai ? { ai: line.ai } : {}),
    ...(line.speaker ? { characterId: line.speaker } : {}),
    ...(line.locked ? { isLocked: true } : {}),
  };
};

export const createSampleProject = (): MoriProject => ({
  id: "mori_sample_hollowmere",
  name: "Lanterns of Hollowmere (demo)",
  sourceFiles: ["dialogue/chapter1.json", "dialogue/market.json", "ui/menus.csv"],
  characters: SAMPLE_CHARACTERS,
  glossary: SAMPLE_GLOSSARY,
  context: {
    global: "「」 for dialogue. Keep {placeholders} and <tags> exactly as written.",
    project: "Lanterns of Hollowmere: English to Japanese. Chapter 1 dialogue, the market scene and menu text.",
  },
  rows: SAMPLE_LINES.map(toRow),
  lastModified: new Date().toISOString(),
});
