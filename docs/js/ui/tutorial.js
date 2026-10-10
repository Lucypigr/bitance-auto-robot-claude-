// 新手篇：分頁式教學（純靜態內容，名詞旁的 ⓘ 沿用說明表）
import { decorate } from './info.js';
import { notesHtml } from './notes.js';

export const PAGES = [
  {
    id: 'what',
    title: '回測是什麼？',
    html: `
      <p>把「<span data-term="backtest">回測</span>」想成<b>用歷史資料做模擬考</b>：你先訂好交易規則（例如「RSI 超買就做空，賺 5% 停利、賠 3% 停損」），軟體再回到過去，照規則一根一根 K 線「假裝」下單，最後算出賺賠。</p>
      <div class="tut-cols">
        <div class="tut-box good"><h4>它能回答</h4><ul>
          <li>這個規則在<b>過去</b>大概長什麼樣子？</li>
          <li>扣掉手續費、滑價、資金費率後還賺不賺？</li>
          <li>最慘時帳面會虧多少（<span data-term="drawdown">最大回撤</span>）？</li></ul></div>
        <div class="tut-box bad"><h4>它不能保證</h4><ul>
          <li>未來一定也賺（市場會變）</li>
          <li>真實成交一定跟模擬一樣</li>
          <li>賺得多＝策略好（可能只是運氣或<span data-term="overfitting">過度擬合</span>）</li></ul></div>
      </div>
      <p class="tut-tip">📌 完整注意事項在教學的最後一頁。</p>
      <p class="tut-tip">💡 本平台只用<b>已收盤</b>的 K 線做判斷、下一根開盤才成交（沒有偷看未來），而且手續費、滑價、槓桿、資金費率、清算都算進去，所以結果會比「不扣成本」的網站保守。</p>`,
  },
  {
    id: 'first',
    title: '第一次操作（5 分鐘）',
    html: `
      <ol class="tut-steps">
        <li><b>選市場與幣種</b><br>左側「① 市場與資料」：新手建議先用 <b>USDT 永續合約</b> 或 <b>現貨</b>，勾 1～3 個主流幣（BTC、ETH）。一次最多 15 個。</li>
        <li><b>選週期與天數</b><br>執行週期先用 <b>1h</b>、天數 <b>180</b>。天數越長越可信，但下載越慢（首次下載後會暫存在瀏覽器）。</li>
        <li><b>保留預設成本</b><br>本金 10,000、手續費 0.05%、滑價 0.05% 都是合理的預設，先別動。</li>
        <li><b>選「🔎 自動搜尋」</b><br>候選數保持 120，按「開始搜尋」。系統會試很多組合，只用<b>前 70%</b>的資料挑出三位冠軍。</li>
        <li><b>先看「樣本外」</b><br>搜尋完成後往右看結果。樣本外＝挑選時<b>完全沒看過</b>的後 30%，比訓練期更接近真實。</li>
      </ol>
      <p class="tut-tip">🚀 想直接看效果？按下面的按鈕，系統會幫你填好 BTC＋ETH 並跑一次自動搜尋。</p>
      <div class="tut-actions"><button type="button" class="btn primary" data-tut-demo>🚀 一鍵示範</button></div>`,
  },
  {
    id: 'settings',
    title: '設定怎麼選',
    html: `
      <table class="tbl tut-tbl"><thead><tr><th>設定</th><th class="txt">新手建議</th><th class="txt">為什麼</th></tr></thead><tbody>
        <tr><td>市場</td><td class="txt">永續或現貨</td><td class="txt"><span data-term="spot">現貨</span>只能做多、沒有清算；<span data-term="perp">永續</span>可做空與槓桿，風險較高。</td></tr>
        <tr><td>台股</td><td class="txt">只有日線</td><td class="txt">免費資料只有日 K，且只做多、整股成交，成本含證交稅。</td></tr>
        <tr><td>執行週期</td><td class="txt">1h 或 4h</td><td class="txt">週期越短交易越多、成本越吃重；5m 資料量大、下載慢。</td></tr>
        <tr><td>天數</td><td class="txt">180 以上</td><td class="txt">太短只涵蓋一種行情，結果不具代表性。</td></tr>
        <tr><td>槓桿</td><td class="txt">先 1×</td><td class="txt"><span data-term="leverage">槓桿</span>放大賺賠也放大清算風險，先看無槓桿的結果。</td></tr>
        <tr><td>停損／停利</td><td class="txt">先用價格 %</td><td class="txt">想用金額（例如投入 6U、停利 2U、停損 3U）可切成「USDT 損益金額」；想用「最多虧本金幾 %」可切成「本金 %」，習慣幣安合約介面可用「ROE %」（畫面會即時換算成價格幅度）。</td></tr>
        <tr><td>訓練／樣本外</td><td class="txt">70／30，想更嚴格用 50／50</td><td class="txt">樣本外越長越能檢驗，但訓練資料變少。</td></tr>
      </tbody></table>
      <p class="tut-tip">💡 「進階」折疊裡的選項（資金池、風險比例、USDT 單位等）預設都關閉。若改過後發現怪怪的（例如零交易），畫面會提示並可一鍵恢復預設。</p>`,
  },
  {
    id: 'mode',
    title: '自動搜尋還是手動？',
    html: `
      <div class="tut-cols">
        <div class="tut-box"><h4>🔎 自動搜尋</h4><ul>
          <li>適合：<b>還沒有想法</b>、想看看什麼條件組合在這段資料表現較好</li>
          <li>會產生三位冠軍：<span data-term="champion_winrate">最高勝率</span>、<span data-term="champion_return">最高淨報酬</span>、<span data-term="champion_stable">最穩定</span></li>
          <li>冠軍只用訓練期挑，再用樣本外驗收</li></ul></div>
        <div class="tut-box"><h4>🛠 手動設定</h4><ul>
          <li>適合：<b>已經有想法</b>要驗證（例如「4h RSI 超買且 1h 出現流星線就做空」）</li>
          <li>可用範本快速開始，條件可疊加（且）、也可用「或／非」群組</li>
          <li>想換一組指標？在搜尋的「自訂指標池」勾選即可</li>
          <li>每個條件的參數（週期、門檻、倍數）都能直接輸入數字；自動搜尋也可勾「同時搜尋指標參數」</li></ul></div>
      </div>
      <p>條件多＝訊號少。<b>每多一個「且」條件，交易次數通常會大幅減少</b>，次數太少時結果沒有統計意義（系統會自動展開診斷告訴你卡在哪一層）。</p>`,
  },
  {
    id: 'read',
    title: '怎麼看結果',
    html: `
      <p>建議照這個順序看，不要一開始就盯著最漂亮的數字：</p>
      <ol class="tut-steps">
        <li><b>樣本外淨報酬</b>：是正的嗎？跟訓練期差多少？訓練賺很多、樣本外虧＝典型<span data-term="overfitting">過度擬合</span>。</li>
        <li><b>交易次數</b>：只有個位數的話，再漂亮也可能是運氣。</li>
        <li><b><span data-term="drawdown">最大回撤</span></b>：你撐得住嗎？回撤 −50% 代表中途會虧掉一半本金。</li>
        <li><b>跟「買入持有」比</b>：折騰半天還輸給什麼都不做，那策略就沒有價值。</li>
        <li><b>各幣種損益</b>：總賺是不是全靠某一個幣？只靠一個幣＝不穩。</li>
        <li><b><span data-term="liquidation">清算</span>與 <span data-term="funding">資金費率</span></b>：用槓桿時看有沒有被清算、資金費吃掉多少。</li>
        <li><b><span data-term="pf">PF</span>、<span data-term="sharpe">Sharpe</span>、<span data-term="winrate">勝率</span></b>：輔助參考。勝率高但每次賺小賠大，一樣會虧。</li>
      </ol>
      <p class="tut-tip">📌 結果頁上方的「白話結論」會把這幾點自動整理成綠／黃／紅提示，可以先讀那一塊。</p>`,
  },
  {
    id: 'traps',
    title: '新手常見陷阱',
    html: `
      <ul class="tut-list">
        <li><b>只看訓練期</b>：訓練期是「選出來的」，一定好看。真正要看的是樣本外。</li>
        <li><b>搜尋越多越會騙人</b>：試 300 組，總會有幾組剛好貼合過去。冠軍樣本外變差是常態，不是程式壞了。</li>
        <li><b>結果常常是負的</b>：加上手續費、滑價、資金費率，多數簡單條件本來就賺不到錢。誠實的回測通常比你想像的難看。</li>
        <li><b>槓桿調大就賺更多？</b>：賺跟賠一起放大，而且可能在到達停損前先被清算。</li>
        <li><b>用今天的漲幅榜選幣再回測過去</b>：這是「事後挑贏家」，會高估績效。</li>
        <li><b>勝率 80% 一定很好？</b>：如果平均賺 1、賠 5，勝率 80% 照樣虧。要搭配 PF 與期望值。</li>
        <li><b>交易數太少</b>：少於 20～30 筆的結論很容易是巧合。</li>
        <li><b>回測 ≠ 實盤</b>：實盤有流動性、斷線、情緒、API 延遲等問題，建議先小額驗證。</li>
      </ul>`,
  },
  {
    id: 'robust',
    title: '這是真本事還是運氣？（可信度檢定）',
    html: `
      <p>賺錢不等於有本事。結果頁的「<b>可信度檢定</b>」分頁會幫你回答：<b>這段績效有多少可能只是運氣？</b></p>
      <ul class="tut-list">
        <li><b><span data-term="monte_carlo">重抽樣</span></b>：把你的每筆交易損益隨機重抽幾千次，看總損益的 90% 區間。區間大半都在 0 以下，代表賺的部分很可能只是好運。</li>
        <li><b><span data-term="sign_flip">p 值</span></b>：假設策略其實沒優勢，隨機得到「跟你一樣好」的機率。經驗上 <b>小於 0.05</b> 比較像真的、<b>大於 0.2</b> 很難排除是運氣（這是經驗法則，不是保證）。</li>
        <li><b><span data-term="multiple_testing">多重檢定</span></b>：自動搜尋測了幾百組才挑出冠軍，好成績有一部分是「挑出來的」。系統會顯示校正後的 p 值，<b>最乾淨的仍是沒參與挑選的樣本外</b>。</li>
        <li><b>最大回撤重排</b>：交易順序也是運氣。把順序隨機重排，看 95% 情況下最大回撤會多深，用它評估自己撐不撐得住。</li>
        <li><b><span data-term="mae_mfe">最大浮虧／浮盈</span></b>：看每筆途中走到多慘、多爽，檢視停損停利是不是設得合理。</li>
      </ul>
      <p class="tut-tip">⚠ 這些都是「描述過去的運氣範圍」，不能預測未來；交易不到 30 筆時，任何檢定都很脆弱。</p>`,
  },
  {
    id: 'study',
    title: '現在是單邊還是震盪？市場有「優勢」嗎？（市場研究）',
    html: `
      <p>左側「<b>🔬 市場研究</b>」分頁，先不設計策略，直接問市場兩個問題：</p>
      <ul class="tut-list">
        <li><b>現在是單邊還是震盪？</b>按「分析目前行情」。系統用<span data-term="efficiency_ratio">效率比率</span>把每個標的分成：單邊上漲、單邊下跌、震盪、過渡，並顯示目前狀態與各種行情占了多少時間。</li>
        <li><b>有沒有扣完成本仍賺錢的價格行為？</b>按「開始掃描價格行為」。系統把每種行為（RSI 超賣、跌破布林下軌、K 線型態…）當事件，統計事件後持有一段時間的<b>扣成本後平均報酬</b>，用<span data-term="edge_scan">訓練期篩選、樣本外確認</span>。</li>
      </ul>
      <p><b>怎麼讀結果：</b></p>
      <ul class="tut-list">
        <li>最常見的結果是「沒有任何行為在扣完成本後仍可靠」——這是誠實的答案，不是壞掉。</li>
        <li>「<b>超額報酬</b>」已經扣掉大盤漲跌：只因為整段行情在漲，所以做多什麼都賺，不算優勢。</li>
        <li>看到「✅ 樣本外確認」也只是<b>待驗證的假說</b>。按「建立策略」可以把它填進手動策略，再用完整回測（含停損、槓桿、資金費率）和「可信度檢定」檢驗。</li>
        <li>回測結果頁新增「<b>行情分析</b>」分頁：這個策略的交易，在哪種行情賺、哪種行情賠？</li>
      </ul>
      <p class="tut-tip">⚠ 行情判斷是「事後確認」，轉換的當下一定來不及知道；用行情當過濾條件也會增加過度擬合，請看樣本外。</p>`,
  },
  {
    id: 'position',
    title: '進階部位技巧（ATR、分批、加碼、反手）',
    html: `
      <p>在手動策略的「進階：分批出場、加碼」與停損停利單位可以找到這些功能。<b>建議先從範本開始</b>（新手範本裡有「ATR 波動停損＋分批出場」與「RSI 雙向反手」）。</p>
      <table class="tbl tut-tbl"><thead><tr><th>功能</th><th class="txt">白話說明</th><th class="txt">要小心</th></tr></thead><tbody>
        <tr><td><span data-term="atr_stop">ATR 倍數</span></td><td class="txt">停損停利跟著「近期波動」走：波動大就放寬、波動小就收緊。</td><td class="txt">倍數太小一樣被洗掉；搭配「每筆風險」可讓每筆虧損金額大致固定。</td></tr>
        <tr><td><span data-term="scale_out">分批出場</span></td><td class="txt">先到第一目標賣一半落袋，剩下的繼續抱，可把停損移到成本價（保本）。</td><td class="txt">大賺的幅度會被縮小；保本也更容易被正常回檔洗出場。</td></tr>
        <tr><td><span data-term="scale_in">順勢加碼</span></td><td class="txt">價格往有利方向走一段再加一筆（賺了再加）。</td><td class="txt">要保留資金（每筆投入比例＜100%）；回檔時虧得比不加碼多。</td></tr>
        <tr><td><span data-term="scale_in">逢低分批進場</span></td><td class="txt">價格往不利方向走一段再買一筆，拉低平均成本。</td><td class="txt">「越賠越買」，行情一路走壞時虧損被放大。</td></tr>
        <tr><td><span data-term="reversal">雙向反手</span></td><td class="txt">多空各自設條件；持單時遇到對面訊號，直接平倉並反向開倉。</td><td class="txt">交易次數與成本大增，震盪盤容易被來回打臉；只支援永續合約。</td></tr>
      </tbody></table>
      <p class="tut-tip">💡 加了這些功能之後，一樣要看樣本外與「可信度檢定」：功能越多、可調的地方越多，越容易過度擬合。</p>`,
  },
  {
    id: 'next',
    title: '進階：下一步學什麼',
    html: `
      <p>等你熟悉基本流程，可以用這些工具檢查策略是不是真的穩：</p>
      <ul class="tut-list">
        <li><b>參數敏感度</b>（結果頁分頁）：把停損／停利稍微調一點，績效會不會劇烈變化？一片平坦＝穩、只有一個尖峰＝可疑。</li>
        <li><b><span data-term="walk_forward">走動式驗證</span></b>：把資料切成多段，每段都「先訓練、再用沒看過的資料驗收」，最後串接成一條曲線，比單一次 70/30 更嚴格。</li>
        <li><b>市場研究</b>：判斷目前是單邊還是震盪，並掃描「扣完成本後仍賺錢的價格行為」。</li>
        <li><b>調整指標參數</b>：RSI 週期、均線長度、MACD、布林倍數都能改。數字越小越敏感、訊號越多；但逐一調到「過去最漂亮」是最常見的過度擬合，改完請看樣本外與參數敏感度。</li>
        <li><b>條件邏輯</b>：「或」與「非」讓條件更靈活，例如「RSI 超賣 <i>或</i> 看漲吞噬」。</li>
        <li><b>部位規則</b>：共用資金池、同時最多持倉數、每筆風險 % 定位。</li>
        <li><b>各幣種損益</b>：多幣種時，檢查是誰賺、誰賠。</li>
      </ul>
      <p class="tut-tip">⚠ 本平台僅供學習與研究，不構成投資建議。任何策略上線前，請先用你負擔得起的小額資金驗證。</p>
      <div class="tut-actions"><button type="button" class="btn primary" data-tut-next>下一頁：注意事項 →</button></div>`,
  },
  {
    id: 'notes',
    title: '⚠ 注意事項（請務必看）',
    html: `<p>使用結果前，請先了解這些限制與常見誤區：</p>${notesHtml()}
      <div class="tut-actions"><button type="button" class="btn primary" data-tut-close>我了解了，開始使用</button></div>`,
  },
];

let root = null;
let page = 0;
let lastFocus = null;
let onDemo = () => {};

function render() {
  const p = PAGES[page];
  root.querySelector('.tut-body').innerHTML = `<h3>${page + 1}. ${p.title}</h3>${p.html}`;
  decorate(root);
  root.querySelector('.tut-prev').disabled = page === 0;
  root.querySelector('.tut-next').disabled = page === PAGES.length - 1;
  root.querySelector('.tut-count').textContent = `${page + 1} ／ ${PAGES.length}`;
  root.querySelectorAll('.tut-dot').forEach((d, i) => { d.classList.toggle('on', i === page); d.setAttribute('aria-current', i === page ? 'step' : 'false'); });
  root.querySelector('.tut-body').scrollTop = 0;
}

function go(i) { page = Math.max(0, Math.min(PAGES.length - 1, i)); render(); }

export function closeTutorial() {
  if (!root || root.hidden) return;
  root.hidden = true;
  document.body.classList.remove('tut-open');
  try { localStorage.setItem('tutorial-seen', '1'); } catch { /* ignore */ }
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

export function openTutorial(i = 0) {
  if (!root) build();
  lastFocus = document.activeElement;
  root.hidden = false;
  document.body.classList.add('tut-open');
  go(i);
  root.querySelector('.tut-close').focus();
}

function build() {
  root = document.createElement('div');
  root.id = 'tutorial';
  root.className = 'tut-overlay';
  root.hidden = true;
  root.innerHTML = `
    <div class="tut-panel" role="dialog" aria-modal="true" aria-labelledby="tut-title" data-testid="tutorial">
      <div class="tut-head"><h2 id="tut-title">🔰 新手篇：怎麼使用回測平台</h2><button type="button" class="btn ghost small tut-close" aria-label="關閉">✕</button></div>
      <div class="tut-dots" role="group" aria-label="頁面">${PAGES.map((p, i) => `<button type="button" class="tut-dot" data-i="${i}" title="${p.title}" aria-label="${i + 1}. ${p.title}"></button>`).join('')}</div>
      <div class="tut-body" tabindex="0"></div>
      <div class="tut-foot"><button type="button" class="btn tut-prev">← 上一頁</button><span class="tut-count muted small"></span><button type="button" class="btn primary tut-next">下一頁 →</button></div>
    </div>`;
  document.body.appendChild(root);
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t === root || t.closest('.tut-close') || t.closest('[data-tut-close]')) { closeTutorial(); return; }
    if (t.closest('.tut-prev')) go(page - 1);
    else if (t.closest('.tut-next')) go(page + 1);
    else if (t.closest('.tut-dot')) go(+t.closest('.tut-dot').dataset.i);
    else if (t.closest('[data-tut-next]')) go(page + 1);
    else if (t.closest('[data-tut-demo]')) { closeTutorial(); onDemo(); }
  });
  document.addEventListener('keydown', (e) => {
    if (!root || root.hidden) return;
    if (e.key === 'Escape') closeTutorial();
    else if (e.key === 'ArrowRight') go(page + 1);
    else if (e.key === 'ArrowLeft') go(page - 1);
    else if (e.key === 'Tab') { // 簡易焦點圈
      const f = [...root.querySelectorAll('button:not(:disabled), [tabindex="0"]')];
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

export function initTutorial({ demo } = {}) {
  if (demo) onDemo = demo;
  for (const el of document.querySelectorAll('[data-open-tutorial]')) {
    el.addEventListener('click', () => { const i = PAGES.findIndex((p) => p.id === el.dataset.openTutorial); openTutorial(i < 0 ? 0 : i); });
  }
  try { if (localStorage.getItem('tutorial-seen')) document.querySelectorAll('.tut-new').forEach((e) => e.classList.remove('tut-new')); } catch { /* ignore */ }
}
