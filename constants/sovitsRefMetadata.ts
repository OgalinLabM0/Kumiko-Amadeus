import type { EmotionType } from '../types';
import { EMOTION_TO_SOVITS_REF } from './emotionConfig';

/**
 * UI-facing metadata for the 25 GPT-SoVITS reference audio slots.
 *
 * Data contract:
 * - `file` values are the exact set of file-name stems used by
 *   `EMOTION_TO_SOVITS_REF` in `constants/emotionConfig.ts`; both layers
 *   must stay in sync through this field.
 * - `defaultPromptText` must stay byte-identical to the corresponding
 *   `promptText` in `EMOTION_TO_SOVITS_REF`. A dev-time `console.assert`
 *   at the bottom of this file warns on any drift.
 *
 * Wording policy (hard rules for maintainers):
 * - `hintZh` / `hintEn` describe ONLY sonic qualities: volume, pace,
 *   tail shape, breath, pitch trend. They must NOT reference any source
 *   media (anime / TV / BD / theatrical / clip / excerpt / scene / etc.)
 *   or characters — the software is fully agnostic to how the user
 *   obtained their reference audio.
 * - `translationZh` is a strictly literal rendering of the Japanese
 *   `defaultPromptText`, used only as a tooltip. No scene context,
 *   interpretation, or narration is added.
 */
export interface SovitsRefMetadata {
    file: string;
    emotion: EmotionType;
    labelZh: string;
    labelEn: string;
    defaultPromptText: string;
    translationZh: string;
    hintZh: string;
    hintEn: string;
}

export const SOVITS_REF_METADATA: SovitsRefMetadata[] = [
    {
        file: 'neutral_casual',
        emotion: 'neutral',
        labelZh: '平静 · 日常寒暄',
        labelEn: 'Neutral · Casual',
        defaultPromptText: '万が一ってこともあるし…ごめん奏ちゃん、あとお願いできる?',
        translationZh: '也有万一的情况⋯⋯对不起奏，之后可以拜托你吗?',
        hintZh: '语速平和、尾音带一点歉意下沉；整体放松不紧绷',
        hintEn: 'Calm pacing with a softly apologetic dip at the end; relaxed overall',
    },
    {
        file: 'neutral_formal',
        emotion: 'neutral',
        labelZh: '平静 · 陈述自述',
        labelEn: 'Neutral · Narrative',
        defaultPromptText: '2年生の秋、先輩の引退とともに、私は北宇治高校吹奏楽部部長に任命された。',
        translationZh: '高二的秋天，随着学长学姐引退，我被任命为北宇治高中管乐部部长。',
        hintZh: '节奏稳定、咬字清晰；声线偏低、自述口吻、几乎无起伏',
        hintEn: 'Even cadence, crisp articulation; low-ish voice, self-narrating, little variation',
    },
    {
        file: 'happy_teasing',
        emotion: 'smiling',
        labelZh: '微笑 · 轻松打趣',
        labelEn: 'Smiling · Light tease',
        defaultPromptText: 'まあ、そうだね~奏ちゃんはかわいい後輩だし~',
        translationZh: '嘛，也是啦～奏是个可爱的后辈嘛～',
        hintZh: '尾音被拉长并上扬、句中藏笑意气息；语速略松',
        hintEn: 'Drawn-out rising tail with a breathy smile mid-phrase; slightly loose pace',
    },
    {
        file: 'happy_playful',
        emotion: 'happy',
        labelZh: '开心 · 俏皮辩驳',
        labelEn: 'Happy · Playful',
        defaultPromptText: '部長だって頑張ってるんだから~！',
        translationZh: '部长也在努力啦～！',
        hintZh: '音量偏高、尾音上挑带小峰值；语气明亮活泼',
        hintEn: 'Raised volume, rising tail with a small peak; bright and lively tone',
    },
    {
        file: 'happy_laughing',
        emotion: 'smug',
        labelZh: '得意 · 笑意带腔调',
        labelEn: 'Smug · Breathy chuckle',
        defaultPromptText: 'だって、そうだろうなあって思ってたし。大変だよね？先輩って。',
        translationZh: '因为我就觉得肯定会这样嘛。当学长学姐挺辛苦的吧?',
        hintZh: '句间夹轻笑气息、尾音轻挑；音量中等、语调从容带戏谑',
        hintEn: 'Light breathy chuckle between clauses, upward tail flick; medium volume with a playful ease',
    },
    {
        file: 'angry_intense',
        emotion: 'angry',
        labelZh: '生气 · 激烈反驳',
        labelEn: 'Angry · Heated retort',
        defaultPromptText: 'じゃあ、麗奈はどうしたらいいと思うの？上から正論言って納得するなら、誰だって苦労しないよ！',
        translationZh: '那么，丽奈觉得该怎么办？光从上头讲大道理就能让人信服，谁都不用这么辛苦了！',
        hintZh: '音量陡升、语速变快；尾音强收带呼吸冲击',
        hintEn: 'Sharp volume spike, faster pace; forceful ending with breath impact',
    },
    {
        file: 'angry_mild',
        emotion: 'disgusted',
        labelZh: '不悦 · 低声抱怨',
        labelEn: 'Displeased · Muttering',
        defaultPromptText: '麗奈は子供の頃からプロ奏者しか目指してなかったんだもんね。',
        translationZh: '丽奈从小就只以成为职业演奏家为目标嘛。',
        hintZh: '音量偏低、尾音发闷；语速平稳，夹一丝不屑气息',
        hintEn: 'Lower volume, muted tail; steady pace with a whiff of dismissiveness',
    },
    {
        file: 'sad_subdued',
        emotion: 'sad',
        labelZh: '低落 · 压抑沉思',
        labelEn: 'Sad · Subdued reflection',
        defaultPromptText: '各章が、春夏秋冬になってるって聞いたけど……結構……壮大、だよね……',
        translationZh: '听说各乐章分别对应春夏秋冬⋯⋯相当⋯⋯宏大，对吧⋯⋯',
        hintZh: '整体音量压低、停顿变长；尾音逐步渐弱、句尾气息薄',
        hintEn: 'Suppressed volume, lengthened pauses; tail fades gradually, thin breath at phrase end',
    },
    {
        file: 'sad_holding_back',
        emotion: 'sad',
        labelZh: '隐忍 · 压哽咽',
        labelEn: 'Sad · Holding back',
        defaultPromptText: 'ソリが私から別の子になった……うまくなって絶対取り返すぞって思ってる。',
        translationZh: '独奏从我这里被换给了另一个人⋯⋯我想着要练得更好，一定要夺回来。',
        hintZh: '声线轻微颤动、呼吸略急；尾音收紧带抖',
        hintEn: 'Faint tremor in the voice, slightly quickened breathing; tail tightens with a waver',
    },
    {
        file: 'sad_crying',
        emotion: 'sad',
        labelZh: '悲伤 · 带泪倾诉',
        labelEn: 'Sad · Tearful',
        defaultPromptText: 'それを誇らしいって、思う自分に胸を張りたい…それで……最後は麗奈と、吹きたかった。',
        translationZh: '想对把这视为骄傲的自己挺起胸膛⋯⋯然后⋯⋯最后，想和丽奈一起吹。',
        hintZh: '句中吸气明显、声音带湿润质感；尾音下坠拖长',
        hintEn: 'Audible in-breaths mid-phrase, wet-sounding voice; tail sinks and lengthens',
    },
    {
        file: 'sad_crying_intense',
        emotion: 'sad',
        labelZh: '崩溃 · 带泪呐喊',
        labelEn: 'Sad · Tearful cry',
        defaultPromptText: 'こんなに練習しているのに、うまくならないはずない！こんなに真剣に向き合ってるのに、響かないはずない！',
        translationZh: '练习了这么多，不可能练不好！这么认真地面对着，不可能不响！',
        hintZh: '音量陡升、含哽咽高频；尾音开裂、换气急促',
        hintEn: 'Sudden volume surge with sobbing highs; cracking tail, rushed breaths',
    },
    {
        file: 'worried_low',
        emotion: 'worried',
        labelZh: '担忧 · 低声叹息',
        labelEn: 'Worried · Low sigh',
        defaultPromptText: 'はぁ…どうなるんだろう、そうなったら、緑ちゃんは…',
        translationZh: '唉⋯⋯会怎么样呢，要真那样的话，绿就⋯⋯',
        hintZh: '开头带叹息气息、整体音量偏低；尾音拖长渐弱',
        hintEn: 'Opens with a sigh, overall low volume; trailing tail fades out',
    },
    {
        file: 'worried_assertive',
        emotion: 'worried',
        labelZh: '担忧 · 坚定质问',
        labelEn: 'Worried · Firm query',
        defaultPromptText: 'みんな従ってるよ。ただ、理解できないって言ってる人に、気持ちに蓋して妄信しろって言うのは無理でしょ？',
        translationZh: '大家都照做了啊。只是对那些说无法理解的人，要他们压下心情盲信是不可能的吧?',
        hintZh: '音量中等偏强、尾音轻挑；节奏偏急、带紧张感',
        hintEn: 'Medium-strong volume, slight upward tail flick; rushed pace with tension',
    },
    {
        file: 'resigned_insecure',
        emotion: 'worried_2',
        labelZh: '不安 · 自我消解',
        labelEn: 'Unsettled · Self-doubt',
        defaultPromptText: '正直、音大はないかなって思ってる。大人になっても演奏を続けていたいって人が、行くべきところだと思うから。',
        translationZh: '老实说，我觉得音乐大学对我来说不太可能。那地方应该留给长大以后也想继续演奏的人。',
        hintZh: '音量偏弱、语速略慢；尾音渐隐、透出一点犹豫气息',
        hintEn: 'Weaker volume, slightly slow; fading tail with a hint of hesitation',
    },
    {
        file: 'shy_embarrassed',
        emotion: 'shy',
        labelZh: '害羞 · 吞吐道谢',
        labelEn: 'Shy · Stuttered thanks',
        defaultPromptText: '何というか……まあ…ありがとう……',
        translationZh: '该怎么说呢⋯⋯嘛⋯⋯谢谢⋯⋯',
        hintZh: '音量压低、句间停顿多；尾音含糊、带不自然的拖音',
        hintEn: 'Low volume, frequent pauses; mumbled tail with awkward drag',
    },
    {
        file: 'neutral_elevated',
        emotion: 'confused',
        labelZh: '疑惑 · 语气上挑',
        labelEn: 'Confused · Upward lift',
        defaultPromptText: 'むしろ、みんな歓迎してくれると思うよ。元清良女子なら即戦力間違いなしだって。',
        translationZh: '反而我觉得大家会欢迎你哦。原清良女子的，肯定是即战力没错。',
        hintZh: '整体音量正常、句末轻微上挑；节奏中等偏快、带询问色',
        hintEn: 'Normal volume, slight upward lift at phrase ends; moderately fast with a questioning color',
    },
    {
        file: 'shy_denial',
        emotion: 'confused_2',
        labelZh: '极度困惑 · 否认',
        labelEn: 'Baffled · Denial',
        defaultPromptText: '別に恥ずかしがってないよ!',
        translationZh: '我才没有害羞呢！',
        hintZh: '音量骤升、语速偏快；尾音短促、气息略慌',
        hintEn: 'Abrupt volume spike, quick pace; clipped tail with a fluster in the breath',
    },
    {
        file: 'resigned_dismissive',
        emotion: 'resigned',
        labelZh: '无奈 · 冷静陈述',
        labelEn: 'Resigned · Dismissive',
        defaultPromptText: 'オーディションで一番うまかった人が吹く、それだけだよ。',
        translationZh: '甄选里吹得最好的人来吹，就这么回事。',
        hintZh: '声线平直、音量中等偏弱；尾音平收，几乎无起伏',
        hintEn: 'Flat voice line, medium-low volume; level ending with almost no variation',
    },
    {
        file: 'resigned_helpless',
        emotion: 'resigned',
        labelZh: '无奈 · 支吾为难',
        labelEn: 'Resigned · Hesitant',
        defaultPromptText: 'みんなが知らなければいいんだけど……奏ちゃんみたいに、何かあるって気付いてる子もいるから……逆にやっかいというか……',
        translationZh: '要是大家都不知道就好了⋯⋯可也有像奏那样察觉到有事的孩子⋯⋯反倒更麻烦⋯⋯',
        hintZh: '句末频繁拖长带气音；整体音量中等、夹杂轻叹',
        hintEn: 'Frequent breathy drag at phrase ends; medium volume with occasional light sighs',
    },
    {
        file: 'sleepy_tired',
        emotion: 'sleepy',
        labelZh: '疲倦 · 长吁',
        labelEn: 'Sleepy · Weary',
        defaultPromptText: 'ほんと疲れたよ~長い1日だった……',
        translationZh: '真的累坏了～漫长的一天⋯⋯',
        hintZh: '声音松软、语速变慢；尾音拖长带叹气',
        hintEn: 'Soft slack voice, slower pace; elongated sighing tail',
    },
    {
        file: 'resigned_exhausted',
        emotion: 'sleepy',
        labelZh: '脱力 · 自语复盘',
        labelEn: 'Exhausted · Muttering',
        defaultPromptText: 'コンクールの練習に、合宿の段取り……これを優子先輩や夏紀先輩はやってたのか……',
        translationZh: '比赛的练习，还有集训的安排⋯⋯这些以前优子学姐和夏纪学姐都在做吗⋯⋯',
        hintZh: '音量低、声线略哑；句间呼吸变长、尾音下坠',
        hintEn: 'Low volume, slightly hoarse line; longer breaths between phrases, sinking tail',
    },
    {
        file: 'serious_low',
        emotion: 'serious',
        labelZh: '严肃 · 低声凝练',
        labelEn: 'Serious · Low focus',
        defaultPromptText: '想像してみたの、全国で北宇治が演奏するところ。その最初の一音は何がいいかって。',
        translationZh: '我想象过哦，北宇治在全国舞台上演奏的画面。第一个音该是什么才好。',
        hintZh: '声线压低、咬字紧致；节奏缓稳、几乎不起伏',
        hintEn: 'Lowered line, tight articulation; calm steady pace with minimal variation',
    },
    {
        file: 'serious_normal',
        emotion: 'serious',
        labelZh: '严肃 · 正式宣告',
        labelEn: 'Serious · Formal statement',
        defaultPromptText: '年に一度だけの吹奏楽コンクール。そこに出場するメンバーを決めるオーディション。',
        translationZh: '一年只有一次的管乐比赛。用来决定出赛成员的甄选。',
        hintZh: '音量适中、吐字干脆；声线平直、带一点权威感',
        hintEn: 'Measured volume, crisp delivery; flat line with a touch of authority',
    },
    {
        file: 'gentle',
        emotion: 'gentle',
        labelZh: '温柔 · 回忆细语',
        labelEn: 'Gentle · Reminiscing',
        defaultPromptText: 'ここはね……2年前、麗奈がソロをかけてオーディションした場所なんだ……',
        translationZh: '这里啊⋯⋯是两年前丽奈为争取独奏而参加甄选的地方⋯⋯',
        hintZh: '声线柔、音量小、气息长；尾音缓缓下滑',
        hintEn: 'Soft line, quiet volume, long breath; tail glides gently downward',
    },
    {
        file: 'surprised_excited',
        emotion: 'surprised',
        labelZh: '惊喜 · 上扬追问',
        labelEn: 'Surprised · Excited question',
        defaultPromptText: 'えっ！じゃあ、サリーちゃんもここにいるってことだよね?',
        translationZh: '咦！那也就是说Sally也在这里咯?',
        hintZh: '起音突然、音量陡升；尾音高挑带期待感',
        hintEn: 'Abrupt onset, sharp volume spike; high rising tail with anticipation',
    },
];

try {
    const byFile = new Map<string, string>();
    (Object.keys(EMOTION_TO_SOVITS_REF) as EmotionType[]).forEach((emotion) => {
        for (const variant of EMOTION_TO_SOVITS_REF[emotion]) {
            byFile.set(variant.file, variant.promptText);
        }
    });
    for (const row of SOVITS_REF_METADATA) {
        const ref = byFile.get(row.file);
        console.assert(
            ref !== undefined,
            `[SOVITS_REF_METADATA] "${row.file}" is missing from EMOTION_TO_SOVITS_REF`,
        );
        console.assert(
            ref === row.defaultPromptText,
            `[SOVITS_REF_METADATA] "${row.file}" defaultPromptText has drifted from emotionConfig`,
        );
    }
    console.assert(
        SOVITS_REF_METADATA.length === 25,
        `[SOVITS_REF_METADATA] expected 25 entries, got ${SOVITS_REF_METADATA.length}`,
    );
} catch {
    /* no-op — assertion block is best-effort only */
}
