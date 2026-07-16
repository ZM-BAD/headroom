/**
 * Shared calibration harness (spec 004 §B) — corpus, bucket counting, and the
 * least-squares fit used by every per-platform calibration script.
 *
 * Method: imports the REAL estimateTokens from utils/estimate.ts and extracts
 * per-bucket counts via one-hot coefficients ({cjk:1, rest:0} → exact CJK char
 * count as the engine sees it). This matters because "pure" samples are never
 * pure: CJK punctuation (。，) is Script=Common so the engine counts it as a
 * Latin word, and markdown symbols (| ``` - **) land in the Latin bucket too.
 * A joint 6-variable least-squares fit (no intercept) across the whole corpus
 * attributes those cross-contaminations correctly; per-bucket division would
 * not. Markdown overhead is absorbed into the coefficients by including
 * markdown-formatted samples (spec 004 §5 — no runtime markdown parsing).
 *
 * Validation: mixed-script samples are held OUT of the fit and checked against
 * the ±15% error target with the final rounded (2-decimal) coefficients.
 *
 * Scripts importing this module must run under
 *   node --experimental-strip-types
 * because the engine import is a .ts file.
 */
import { estimateTokens } from "../utils/estimate.ts";

export const BUCKETS = ["cjk", "kana", "hangul", "cyrillic", "arabic", "latin"];

/** Exact per-bucket counts as the engine counts them (one-hot trick). */
export function countBuckets(text) {
  return BUCKETS.map((b) =>
    estimateTokens(
      text,
      Object.fromEntries(BUCKETS.map((k) => [k, k === b ? 1 : 0])),
    ),
  );
}

// ---- calibration corpus (spec 004 §B.3) ----
// Prose + markdown per writing system. Sizes 80–400 chars for stable ratios.

export const CORPUS = [
  // —— CJK (Chinese prose + markdown) ——
  {
    group: "cjk",
    text: "人工智能正在改变我们的工作方式。大型语言模型能够理解自然语言,回答问题,编写代码,甚至进行创意写作。然而,这些模型的上下文窗口是有限的,当对话过长时,早期的内容会被截断或遗忘,用户往往对此毫无察觉。",
  },
  {
    group: "cjk",
    text: "今天下午我去了一趟超市,买了一些水果和蔬菜。回家的路上突然下起了大雨,幸好我带了伞。晚饭做了西红柿炒鸡蛋和青椒肉丝,味道还不错,就是盐放得稍微多了一点。",
  },
  {
    group: "cjk",
    text: "根据最新的研究报告显示,全球气候变化正在加速。科学家们呼吁各国政府采取更积极的减排措施,以避免不可逆转的环境灾难。海平面上升、极端天气频发、生物多样性锐减,这些问题都需要全人类共同面对。",
  },
  {
    group: "cjk",
    text: "浏览器扩展的核心架构包括后台脚本、内容脚本和弹出页面三个部分。后台脚本负责监听网络请求和管理状态,内容脚本注入到目标页面中读取文档结构,弹出页面则提供用户交互界面。三者之间通过消息传递机制进行通信。",
  },
  {
    group: "cjk",
    text: "春眠不觉晓,处处闻啼鸟。夜来风雨声,花落知多少。床前明月光,疑是地上霜。举头望明月,低头思故乡。白日依山尽,黄河入海流。欲穷千里目,更上一层楼。",
  },
  {
    group: "cjk",
    text: "经济学中的边际效用递减规律指的是,在其他条件不变的情况下,消费者连续消费同一种商品,每增加一个单位所带来的满足感会逐渐减少。这个规律解释了为什么第一杯奶茶总是最好喝的。",
  },
  {
    group: "cjk",
    text: "这款手机的续航能力非常出色,重度使用一整天后仍有百分之三十的电量剩余。屏幕显示效果细腻,色彩还原准确,唯一的缺点是充电速度偏慢,完整充满需要接近两个小时。",
  },
  {
    group: "cjk",
    text: "会议纪要:本次评审确定了三个优先事项。第一,优化启动速度;第二,修复已知的同步问题;第三,完善错误提示文案。散会前大家一致同意下周五进行第二轮评审,并由产品经理提前整理测试反馈。",
  },
  {
    group: "cjk-md",
    text: "## 项目进度报告\n\n| 模块 | 状态 | 负责人 |\n|------|------|--------|\n| 数据层 | 已完成 | 张三 |\n| 界面层 | 进行中 | 李四 |\n| 测试 | 未开始 | 王五 |\n\n- **重点**:数据层已通过全部测试\n- 下一步:完成界面层的国际化\n- 风险:测试人力不足",
  },
  {
    group: "cjk-md",
    text: "使用以下命令安装依赖并启动开发服务器:\n\n```bash\nnpm install\nnpm run dev\n```\n\n构建完成后,在浏览器的扩展管理页面加载 `.output` 目录即可。注意**开发模式**和**生产模式**的输出目录不同,不要混用。",
  },

  // —— Kana (pure hiragana / katakana + natural Japanese) ——
  {
    group: "kana",
    text: "ひらがなだけのぶんしょうをかいてみます。きょうはとてもいいてんきですね。あしたはあめがふるかもしれません。かさをもっていくのをわすれないでください。",
  },
  {
    group: "kana",
    text: "コンピュータ、インターネット、スマートフォン、アプリケーション、プログラミング、データベース、ネットワーク、セキュリティ、クラウド、サーバー",
  },
  {
    group: "kana",
    text: "わたしはまいにちあさろくじにおきて、こうえんをさんぽします。それからあさごはんをたべて、しごとをはじめます。よるははやくねるようにしています。",
  },
  {
    group: "kana",
    text: "すもももももももものうち。となりのきゃくはよくかきくうきゃくだ。にわにはにわにわとりがいる。あかまきがみあおまきがみきまきがみ。",
  },
  {
    group: "kana",
    text: "アメリカ、イギリス、フランス、ドイツ、イタリア、スペイン、カナダ、オーストラリア、ブラジル、アルゼンチン、メキシコ、インドネシア",
  },
  {
    group: "kana-mix",
    text: "東京の天気は今日も晴れです。週末は友達と映画を見に行く予定があります。新しいカフェもオープンしたので、そこでランチを食べるつもりです。",
  },
  {
    group: "kana-mix",
    text: "日本語のテキストにはひらがな、カタカナ、漢字が混ざっています。トークンの推定には、それぞれの文字種を別々に数える必要があります。",
  },
  {
    group: "kana-mix",
    text: "このアプリケーションはブラウザのサイドパネルにトークンの使用状況を表示します。設定画面で係数を変更することもできます。データはクラウドに同期されます。",
  },
  {
    group: "kana-md",
    text: "## つかいかた\n\n- まずアプリをインストールします\n- つぎにせっていをひらきます\n- **さいごに**プラットフォームをえらびます\n\nこれでじゅんびはかんりょうです。",
  },

  // —— Hangul (Korean prose + markdown) ——
  {
    group: "hangul",
    text: "안녕하세요. 오늘은 날씨가 정말 좋네요. 주말에 친구들과 함께 등산을 가기로 했습니다. 산 정상에서 보는 풍경이 기대됩니다.",
  },
  {
    group: "hangul",
    text: "인공지능 기술은 빠르게 발전하고 있습니다. 대규모 언어 모델은 자연어를 이해하고 코드를 작성할 수 있습니다. 하지만 컨텍스트 창의 크기는 여전히 제한적입니다.",
  },
  {
    group: "hangul",
    text: "한국 요리는 발효 음식이 많은 것이 특징입니다. 김치, 된장, 고추장은 한국인의 밥상에서 빠질 수 없는 기본 재료입니다. 계절마다 담그는 김치의 종류도 다양합니다.",
  },
  {
    group: "hangul",
    text: "서울은 대한민국의 수도이며 인구가 약 천만 명에 달하는 대도시입니다. 한강이 도시를 가로질러 흐르고 있으며, 지하철 노선이 거미줄처럼 연결되어 있습니다.",
  },
  {
    group: "hangul",
    text: "어제 저녁에 새로운 식당에 갔는데 음식이 정말 맛있었습니다. 특히 해물파전과 막걸리가 일품이었습니다. 다음에는 가족들과 함께 방문할 예정입니다.",
  },
  {
    group: "hangul",
    text: "독서는 마음의 양식이라는 말이 있습니다. 좋은 책을 읽으면 지식뿐만 아니라 삶의 지혜도 얻을 수 있습니다. 매일 조금씩이라도 책을 읽는 습관을 기르는 것이 중요합니다.",
  },
  {
    group: "hangul",
    text: "지하철에서 책을 읽는 사람들이 점점 줄어들고 있습니다. 대부분 스마트폰으로 영상을 보거나 게임을 합니다. 그래도 종이책만의 매력은 여전하다고 생각합니다.",
  },
  {
    group: "hangul-md",
    text: "## 설치 방법\n\n1. 저장소를 복제합니다\n2. 의존성을 설치합니다\n3. **개발 서버**를 실행합니다\n\n| 명령어 | 설명 |\n|--------|------|\n| npm run dev | 개발 모드 |\n| npm run build | 프로덕션 빌드 |",
  },

  // —— Cyrillic (Russian prose + markdown) ——
  {
    group: "cyrillic",
    text: "Искусственный интеллект меняет способы нашей работы. Большие языковые модели могут понимать естественный язык, отвечать на вопросы и писать код. Однако контекстное окно этих моделей ограничено.",
  },
  {
    group: "cyrillic",
    text: "Сегодня утром я пошёл в магазин за продуктами. По дороге домой начался сильный дождь, но у меня был зонт. Вечером приготовил ужин и посмотрел интересный фильм.",
  },
  {
    group: "cyrillic",
    text: "Москва — столица России и крупнейший город страны. Население города составляет более двенадцати миллионов человек. Метро Москвы считается одним из самых красивых в мире.",
  },
  {
    group: "cyrillic",
    text: "Расширение для браузера показывает, сколько контекстного окна осталось в текущем разговоре с языковой моделью. Данные синхронизируются между устройствами через облачное хранилище.",
  },
  {
    group: "cyrillic",
    text: "Классическая русская литература известна во всём мире. Произведения Толстого, Достоевского и Чехова переведены на десятки языков и продолжают вдохновлять читателей.",
  },
  {
    group: "cyrillic",
    text: "Программирование требует терпения и внимательности. Каждая ошибка — это возможность узнать что-то новое о системе. Хороший разработчик всегда пишет тесты для своего кода.",
  },
  {
    group: "cyrillic",
    text: "Осенью в парке очень красиво: листья желтеют и падают на дорожки. Мы часто гуляем там по выходным, пьём кофе и обсуждаем планы на следующую неделю.",
  },
  {
    group: "cyrillic-md",
    text: "## Инструкция по установке\n\n- Клонируйте репозиторий\n- Установите зависимости\n- **Запустите** сервер разработки\n\n| Команда | Описание |\n|---------|----------|\n| npm test | запуск тестов |\n| npm run build | сборка |",
  },

  // —— Arabic (prose + markdown) ——
  {
    group: "arabic",
    text: "الذكاء الاصطناعي يغير طريقة عملنا. النماذج اللغوية الكبيرة قادرة على فهم اللغة الطبيعية والإجابة عن الأسئلة وكتابة التعليمات البرمجية. لكن نافذة السياق في هذه النماذج محدودة.",
  },
  {
    group: "arabic",
    text: "ذهبت هذا الصباح إلى السوق لشراء الخضروات والفواكه. في طريق العودة بدأ المطر يهطل بغزارة، لكن لحسن الحظ كنت أحمل مظلة. في المساء أعددت العشاء وشاهدت فيلماً ممتعاً.",
  },
  {
    group: "arabic",
    text: "القاهرة هي عاصمة مصر وأكبر مدينة في العالم العربي. يمر نهر النيل عبر المدينة من الجنوب إلى الشمال. تشتهر المدينة بمتاحفها وأسواقها القديمة.",
  },
  {
    group: "arabic",
    text: "تعرض إضافة المتصفح مقدار نافذة السياق المتبقية في المحادثة الحالية مع النموذج اللغوي. تتم مزامنة البيانات بين الأجهزة عبر التخزين السحابي.",
  },
  {
    group: "arabic",
    text: "الأدب العربي غني بالشعر والنثر. المعلقات من أشهر القصائد في التاريخ العربي القديم. وما زال الشعر يحتل مكانة مهمة في الثقافة العربية المعاصرة.",
  },
  {
    group: "arabic",
    text: "البرمجة تتطلب الصبر والدقة. كل خطأ هو فرصة لتعلم شيء جديد عن النظام. المبرمج الجيد يكتب اختبارات لكل جزء من الكود قبل دمجه في المشروع.",
  },
  {
    group: "arabic",
    text: "في فصل الصيف ترتفع درجات الحرارة في الخليج العربي إلى مستويات قياسية. يفضل السكان الخروج في الصباح الباكر أو بعد غروب الشمس لتجنب الحر الشديد.",
  },
  {
    group: "arabic-md",
    text: "## خطوات التثبيت\n\n- انسخ المستودع\n- ثبت الاعتماديات\n- **شغل** خادم التطوير\n\n| الأمر | الوصف |\n|-------|-------|\n| npm test | تشغيل الاختبارات |",
  },

  // —— LLM-answer-shaped samples (prose with sprinkled markdown — the text
  // shape the engine actually estimates in production) ——
  {
    group: "cjk-llm",
    text: "关于你提到的性能问题,我建议从以下三个方面排查:\n\n1. **网络层**:检查请求是否被重复发送,可以在开发者工具的 Network 面板中观察\n2. **渲染层**:长列表建议使用虚拟滚动,避免一次性渲染全部节点\n3. **数据层**:高频更新的状态应该做防抖处理\n\n如果以上三点都排除了,问题很可能出在第三方依赖上。建议用性能分析工具录制一段火焰图,找到耗时最长的函数调用栈再做针对性优化。",
  },
  {
    group: "cjk-llm",
    text: "这个错误通常是因为异步操作未正确等待导致的。修改方法如下:\n\n```javascript\nconst data = await fetchData();\nconsole.log(data.items);\n```\n\n注意 `await` 只能在 `async` 函数内使用。如果你在顶层代码中调用,需要把逻辑包裹在一个立即执行的异步函数里,或者使用顶层 await(需要 ES2022 模块环境)。",
  },
  {
    group: "kana-llm",
    text: "ご質問ありがとうございます。この問題は以下の手順で解決できます:\n\n1. まず設定画面を開いてください\n2. **詳細設定**タブを選択します\n3. キャッシュをクリアして再起動します\n\nそれでも解決しない場合は、拡張機能を一度削除してから再インストールしてみてください。データはクラウドに保存されているので失われません。",
  },
  {
    group: "hangul-llm",
    text: "질문해 주셔서 감사합니다. 이 문제는 다음 단계로 해결할 수 있습니다:\n\n1. 먼저 설정 화면을 엽니다\n2. **고급 설정** 탭을 선택합니다\n3. 캐시를 지우고 다시 시작합니다\n\n그래도 해결되지 않으면 확장 프로그램을 삭제한 후 다시 설치해 보세요. 데이터는 클라우드에 저장되어 있으므로 손실되지 않습니다.",
  },

  // —— Latin (English prose + markdown + code) ——
  {
    group: "latin",
    text: "Artificial intelligence is transforming the way we work. Large language models can understand natural language, answer questions, and write code. However, the context window of these models is limited, and early content gets truncated silently.",
  },
  {
    group: "latin",
    text: "The browser extension monitors network requests to estimate how many tokens the current conversation has consumed. It displays the remaining headroom in a side panel gauge that updates in real time.",
  },
  {
    group: "latin",
    text: "This morning I went to the grocery store to buy fruits and vegetables. On the way home it started raining heavily, but luckily I had brought an umbrella. For dinner I made pasta with tomato sauce.",
  },
  {
    group: "latin",
    text: "Climate change is accelerating according to recent research. Scientists urge governments to adopt more aggressive emission reduction policies to avoid irreversible environmental damage. Rising sea levels threaten coastal cities worldwide.",
  },
  {
    group: "latin",
    text: "Reading is food for the mind. A good book offers not only knowledge but also wisdom about life itself. Building a daily reading habit, even a few pages at a time, pays compound interest over the years.",
  },
  {
    group: "latin",
    text: "The quarterly report shows steady growth in user engagement. Daily active users increased by fifteen percent compared to the previous quarter, while retention improved across all cohorts.",
  },
  {
    group: "latin",
    text: "The licensee shall not distribute, sublicense, or otherwise transfer the software to any third party without prior written consent from the licensor. Any violation of this clause terminates the agreement immediately.",
  },
  {
    group: "latin-md",
    text: "## Project Status\n\n| Module | Status | Owner |\n|--------|--------|-------|\n| Data layer | Done | Alice |\n| UI layer | In progress | Bob |\n\n- **Key point**: the data layer passed all tests\n- Next step: finish internationalization\n- Risk: QA capacity is tight",
  },
  {
    group: "latin-md",
    text: "To install the dependencies, run the following command:\n\n```bash\nnpm install\nnpm run dev\n```\n\nThen open your browser and navigate to the extensions page. Load the unpacked build from the output directory.",
  },
  {
    group: "latin-md",
    text: "```typescript\nfunction estimateTokens(text: string, coeff: number): number {\n  if (!text) return 0;\n  const words = text.split(/\\s+/).filter(Boolean);\n  return Math.round(words.length * coeff);\n}\n```\n\nThe function above is a simplified single-coefficient estimator.",
  },
];

// ---- held-out validation set (mixed scripts, NOT used in the fit) ----

export const VALIDATION = [
  {
    group: "zh+en",
    text: "我们使用 TypeScript 和 WXT 框架开发这个 browser extension,核心逻辑在 background script 中实现,通过 webRequest API 监听平台的网络请求。",
  },
  {
    group: "ja+en",
    text: "このプロジェクトは TypeScript で書かれています。npm run dev を実行すると開発サーバーが起動します。ビルドは npm run build です。",
  },
  {
    group: "ko+en",
    text: "이 확장 프로그램은 Chrome과 Firefox를 모두 지원합니다. manifest v3 기준으로 개발되었으며 sidePanel API를 사용합니다.",
  },
  {
    group: "zh-md-code",
    text: "## 快速开始\n\n先克隆仓库并安装依赖,然后运行以下命令构建扩展:\n\n```bash\nnpm install && npm run build\n```\n\n构建产物在 .output/chrome-mv3/ 目录下。打开浏览器的扩展管理页面,启用开发者模式,选择「加载已解压的扩展程序」并指向该目录。\n\n| 平台 | 支持情况 |\n|------|----------|\n| Chrome | 完整支持 |\n| Firefox | 完整支持 |\n| Edge | 完整支持 |\n\n如果加载后图标是灰色的,说明当前页面不是受支持的 AI 平台,切换到任意受支持的平台标签页即可看到图标变为彩色。",
  },
  {
    group: "en-code",
    text: "Here is the fix. The handler must guard against a cold service worker start:\n\n```typescript\nbrowser.runtime.onMessage.addListener((msg, sender) => {\n  if (msg.type !== \"STATE_UPDATE\") return;\n  void refreshGauge(msg.payload);\n});\n```\n\nModule-level globals are wiped whenever MV3 suspends the worker, so every listener needs to re-read state from storage instead of trusting an in-memory cache.",
  },
  {
    group: "ru+en",
    text: "Запустите команду npm run typecheck перед коммитом. CI проверяет lint, typecheck и build на каждый push в репозиторий.",
  },
  {
    group: "4-script",
    text: "会议将于明天举行。The meeting is tomorrow. 회의는 내일 열립니다. Встреча состоится завтра. あしたかいぎがあります。",
  },
];

// ---- least squares (no intercept): solve (XᵀX)β = Xᵀy ----

export function fitCoefficients(rows, ys) {
  const n = BUCKETS.length;
  const XtX = Array.from({ length: n }, () => new Array(n).fill(0));
  const Xty = new Array(n).fill(0);
  for (let s = 0; s < rows.length; s++) {
    for (let i = 0; i < n; i++) {
      Xty[i] += rows[s][i] * ys[s];
      for (let j = 0; j < n; j++) XtX[i][j] += rows[s][i] * rows[s][j];
    }
  }
  // Gaussian elimination with partial pivoting.
  const A = XtX.map((row, i) => [...row, Xty[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    [A[col], A[pivot]] = [A[pivot], A[col]];
    if (Math.abs(A[col][col]) < 1e-9) {
      throw new Error(`singular normal matrix at bucket ${BUCKETS[col]}`);
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => row[n] / A[i][i]);
}

export function estimateWith(coeffVec, counts) {
  return counts.reduce((sum, c, i) => sum + c * coeffVec[i], 0);
}

/**
 * Full calibration run for one tokenizer: fit → corpus fit report → held-out
 * validation report. `encodeLen` is an (async ok) (text) => token count.
 * Returns { fitted, rounded, worst } for programmatic use.
 */
export async function runCalibration(label, encodeLen) {
  const rows = CORPUS.map((s) => countBuckets(s.text));
  const ys = [];
  for (const s of CORPUS) ys.push(await encodeLen(s.text));

  const fitted = fitCoefficients(rows, ys);
  const rounded = fitted.map((c) => Math.round(c * 100) / 100);

  console.log(`\n==== ${label} ====`);
  console.log("== Fitted coefficients ==");
  for (let i = 0; i < BUCKETS.length; i++) {
    console.log(
      `  ${BUCKETS[i].padEnd(9)} ${fitted[i].toFixed(4)}  → rounded ${rounded[i].toFixed(2)}`,
    );
  }

  console.log("\n== Calibration corpus fit (rounded coefficients) ==");
  const byGroup = new Map();
  for (let s = 0; s < CORPUS.length; s++) {
    const est = estimateWith(rounded, rows[s]);
    const g = byGroup.get(CORPUS[s].group) ?? { actual: 0, est: 0 };
    g.actual += ys[s];
    g.est += est;
    byGroup.set(CORPUS[s].group, g);
  }
  for (const [group, g] of byGroup) {
    const err = ((g.est - g.actual) / g.actual) * 100;
    console.log(
      `  ${group.padEnd(12)} actual ${String(g.actual).padStart(5)}  est ${String(Math.round(g.est)).padStart(5)}  err ${err >= 0 ? "+" : ""}${err.toFixed(1)}%`,
    );
  }

  console.log("\n== Held-out validation (mixed scripts, target ±15%) ==");
  let worst = 0;
  for (const v of VALIDATION) {
    const actual = await encodeLen(v.text);
    const est = estimateWith(rounded, countBuckets(v.text));
    const err = ((est - actual) / actual) * 100;
    worst = Math.max(worst, Math.abs(err));
    const flag = Math.abs(err) > 15 ? "  ⚠ OVER" : "";
    console.log(
      `  ${v.group.padEnd(12)} actual ${String(actual).padStart(5)}  est ${String(Math.round(est)).padStart(5)}  err ${err >= 0 ? "+" : ""}${err.toFixed(1)}%${flag}`,
    );
  }
  console.log(
    `\nWorst validation error: ${worst.toFixed(1)}% ${worst <= 15 ? "(within ±15% target)" : "(EXCEEDS ±15% target)"}`,
  );
  return { fitted, rounded, worst };
}
