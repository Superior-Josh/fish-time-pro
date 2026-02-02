// 注意：此扩展不依赖外部库，仅使用 VSCode API 与 Node 内置 https。
// 作用：
// 1) 在状态栏显示"今日工资"
// 2) 悬浮提示显示"距离下班时间"
// 3) 读取用户在设置中配置的上下班时间（四段）、月薪与休息日
// 4) 拉取并解析中国节假日 ICS，计算当月总工作日与已上班天数，判断今日是否工作日
// 5) 每秒更新一次显示，逻辑与现有 HTML 页面保持一致（午休、下班后全额、节假日/休息日为 0 等）

const vscode = require('vscode');
const https = require('https');

/**
 * 远程 ICS 源地址（与 HTML 一致）。
 * 包含合法的 DTSTART;VALUE=DATE 与 SUMMARY 描述，用于识别"假期第N天"和"补班/调休"。
 */
const ICS_URL = 'https://www.shuy.com/githubfiles/china-holiday-calender/master/holidayCal.ics';

/**
 * ICS 缓存有效期（毫秒）。避免频繁网络请求，设置为 24 小时。
 */
const ICS_CACHE_TTL = 24 * 60 * 60 * 1000;

// 扩展级状态
let statusBarItem = null;           // 状态栏项
let timerAmount = null;             // 金额更新定时器（100ms）
let timerTooltip = null;            // 悬浮窗更新定时器（1s）
let holidayCache = {                // ICS 缓存
    text: '',
    fetchedAt: 0
};
// 为避免悬浮窗因每次赋值而"闪烁"，记录上次已设置的 tooltip 文本，仅在文本变化时更新
let lastTooltipText = '';
// 最近一次计算的上下文：供金额高频更新复用，避免每100ms都解析 ICS 与月度工作日
let lastContext = null;
// 智能降频：记录窗口焦点状态，前台高频、后台降频
let isFocused = true;
// 定时器间隔（毫秒）：前台/后台两套频率
const TIMER_MS = {
    amountFocused: 1000,
    amountBlurred: 1000,
    tooltipFocused: 1000,
    tooltipBlurred: 5000
};

/**
 * 根据当前焦点状态，重新启动两个定时器。
 * @param {Function} updateTooltip 悬浮窗更新函数（1秒或5秒）
 * @param {Function} updateAmount 金额文本更新函数（100ms或1000ms）
 */
function restartTimers(updateTooltip, updateAmount) {
    if (timerTooltip) {
        clearInterval(timerTooltip);
        timerTooltip = null;
    }
    if (timerAmount) {
        clearInterval(timerAmount);
        timerAmount = null;
    }
    const tt = isFocused ? TIMER_MS.tooltipFocused : TIMER_MS.tooltipBlurred;
    const ta = isFocused ? TIMER_MS.amountFocused : TIMER_MS.amountBlurred;
    timerTooltip = setInterval(updateTooltip, tt);
    timerAmount = setInterval(updateAmount, ta);
}

/**
 * 打开设置+自动填充搜索关键词 【最兼容版本】
 * 使用字符串形式的搜索关键词作为参数，这是VS Code最兼容的方式
 * @param {string} searchKey 要填充的搜索关键词
 */
function openSettingAndSearch(searchKey) {
    // 直接使用字符串形式的搜索关键词作为参数，这是VS Code最兼容的方式
    vscode.commands.executeCommand('workbench.action.openSettings', searchKey);
}

/**
 * 激活扩展：创建状态栏、启动计时器、监听配置变更。
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    // 设置插件启动时间
    extensionStartTime = new Date();

    // 注册自定义命令：打开FishTime设置
    const openFishTimeSettingsCommand = 'fishTime.openSettings';
    const disposable = vscode.commands.registerCommand(openFishTimeSettingsCommand, () => {
        openSettingAndSearch('fishTime');
    });
    context.subscriptions.push(disposable);

    // 创建状态栏项：改为靠左显示，但不最左，保持在其他左侧信息之后
    // VS Code 规则：对于左侧（StatusBarAlignment.Left），优先级数值越大越靠左；越小越靠右。
    // 为了"靠左但不最左"，这里设置一个较小的优先级（例如 -100），让它排在左侧的其他信息后面。
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
    statusBarItem.text = 'FishTime 准备中...';
    statusBarItem.tooltip = '正在初始化...';

    // 添加点击事件：打开并定位到 FishTime 插件设置
    // 使用自定义命令ID，避免直接使用函数导致的command 'undefined' not found错误
    statusBarItem.command = openFishTimeSettingsCommand;

    statusBarItem.show();

    // 启动两个定时器：
    // 1) 悬浮窗（tooltip）每秒刷新一次：计算月度工作日、节假日与当前工作状态；
    // 2) 金额文本每100ms刷新一次：仅根据最近上下文计算今日工资，呈现"连续变化"的视觉效果。
    const updateTooltip = async () => {
        try {
            await updateStatusBar();
        } catch (err) {
            statusBarItem.tooltip = String(err?.message || err);
        }
    };
    const updateAmount = () => {
        try {
            updateAmountText();
        } catch (err) {
            statusBarItem.text = 'FishTime: 金额计算错误';
        }
    };
    // 首次立即更新，保证进入后即有数据
    updateTooltip();
    updateAmount();
    // 根据焦点状态启动定时器（智能降频）
    restartTimers(updateTooltip, updateAmount);

    // 监听窗口焦点变化：前台高频、后台降频
    const winFocusDisposer = vscode.window.onDidChangeWindowState(e => {
        isFocused = !!e.focused;
        restartTimers(updateTooltip, updateAmount);
    });
    context.subscriptions.push(winFocusDisposer);

    // 监听配置变更：用户修改设置后，立即重新计算显示
    const cfgDisposer = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('fishTime')) {
            // 配置变化时，重算上下文并立即刷新两侧显示
            lastContext = null;
            updateTooltip();
            updateAmount();
        }
    });
    context.subscriptions.push(cfgDisposer);

    // 扩展停用时清理定时器
    context.subscriptions.push({
        dispose() {
            if (timerTooltip) { clearInterval(timerTooltip); timerTooltip = null; }
            if (timerAmount) { clearInterval(timerAmount); timerAmount = null; }
        }
    });
}

/**
 * 停用扩展：清理资源。
 */
function deactivate() {
    if (timerTooltip) clearInterval(timerTooltip);
    if (timerAmount) clearInterval(timerAmount);
}

/**
 * 读取用户配置，提供默认值与基本格式校验。
 */
function getConfig() {
    const cfg = vscode.workspace.getConfiguration('fishTime');

    // 月薪
    const monthlySalary = cfg.get('0_monthly-salary', 20450);
    // 读取四段时间，格式为 HH:mm
    const morningStart = cfg.get('1_morning-start', '10:00');
    const morningEnd = cfg.get('2_morning-end', '11:30');
    const afternoonStart = cfg.get('3_afternoon-start', '13:30');
    const afternoonEnd = cfg.get('4_afternoon-end', '18:00');
    // 休息日（数组：1-7代表周一至周日；周日为7）
    const restDays = cfg.get('5_restDays', [6, 7]);

    return {
        monthlySalary,
        morningStart,
        morningEnd,
        afternoonStart,
        afternoonEnd,
        restDays
    };
}

/**
 * 工具：将 HH:mm 字符串转为分钟数（从 00:00 起）；非法则返回默认。
 * @param {string} hhmm
 * @param {number} defMinutes 默认分钟（例如 9:00 -> 540）
 */
function parseHHMMToMinutes(hhmm, defMinutes) {
    try {
        const m = hhmm.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
        if (!m) return defMinutes;
        const h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        return h * 60 + min;
    } catch {
        return defMinutes;
    }
}

/**
 * 工具：根据分钟数设置到一个 Date（当天）。
 * @param {Date} base
 * @param {number} minutesFromMidnight
 */
function setDateToMinutes(base, minutesFromMidnight) {
    const d = new Date(base);
    const h = Math.floor(minutesFromMidnight / 60);
    const m = minutesFromMidnight % 60;
    d.setHours(h, m, 0, 0);
    return d;
}

/**
 * 工具：将毫秒差值格式化为 HH:mm:ss（最小为 00:00:00）。
 * @param {number} msDiff
 */
function formatDiffToHMS(msDiff) {
    if (msDiff <= 0) return '00:00:00';
    const totalSeconds = Math.floor(msDiff / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * 工具：格式化时间为 HH:mm（用于静态显示上午/下午结束时间，避免因每秒倒计时导致的闪烁）
 * @param {Date} d
 */
function formatTimeHHMM(d) {
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
}

/**
 * 拉取节假日 ICS 文本（带缓存）。
 */
async function fetchHolidayICS(context) {
    const now = Date.now();
    // 先读扩展级缓存
    if (holidayCache.text && holidayCache.fetchedAt && (now - holidayCache.fetchedAt) < ICS_CACHE_TTL) {
        return holidayCache.text;
    }
    // 再尝试读全局存储缓存
    try {
        const cached = context?.globalState?.get('fishTime.icsCache');
        if (cached && cached.text && cached.fetchedAt && (now - cached.fetchedAt) < ICS_CACHE_TTL) {
            holidayCache = cached;
            return holidayCache.text;
        }
    } catch { }

    // 网络拉取（https）
    const text = await new Promise((resolve, reject) => {
        https.get(ICS_URL, res => {
            if (res.statusCode !== 200) {
                reject(new Error(`ICS 请求失败，状态码：${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });

    holidayCache = { text, fetchedAt: now };
    try { context?.globalState?.update('fishTime.icsCache', holidayCache); } catch { }
    return text;
}

/**
 * 解析 ICS：提取本月的假期（holidays）与补班/调休工作日（workdays）。
 * 规则与 HTML 保持一致：
 * - DTSTART;VALUE=DATE:YYYYMMDD 记为假期天（如果 SUMMARY 中含"假期第N天"会用于显示，但此处我们只需天数用于工作日计算）
 * - DTSTART:YYYYMMDD... 且 SUMMARY 包含"补班/调休/班/compensateday"视为工作日（覆盖休息日）
 */
function parseICSForMonth(icsText, year, month) {
    const lines = (icsText || '').split('\n');
    const holidays = []; // 假期天（当月）
    const workdays = []; // 补班/调休的工作日（当月）

    let currentEvent = null;
    for (const line of lines) {
        if (line.startsWith('BEGIN:VEVENT')) {
            currentEvent = {};
        } else if (line.startsWith('DTSTART;VALUE=DATE:')) {
            const dateStr = line.split(':')[1];
            const y = parseInt(dateStr.slice(0, 4));
            const m = parseInt(dateStr.slice(4, 6));
            const d = parseInt(dateStr.slice(6, 8));
            if (currentEvent) currentEvent.valueDate = { y, m, d, dateStr };
        } else if (line.startsWith('DTSTART:')) {
            const dateStr = line.split(':')[1].slice(0, 8);
            const y = parseInt(dateStr.slice(0, 4));
            const m = parseInt(dateStr.slice(4, 6));
            const d = parseInt(dateStr.slice(6, 8));
            if (currentEvent) currentEvent.startDate = { y, m, d, dateStr };
        } else if (line.startsWith('SUMMARY:')) {
            const summary = line.split(':')[1] || '';
            if (currentEvent) currentEvent.summary = summary;
        } else if (line.startsWith('END:VEVENT')) {
            if (currentEvent) {
                // 记录假期天（基于 VALUE=DATE）
                if (currentEvent.valueDate && currentEvent.valueDate.y === year && currentEvent.valueDate.m === month) {
                    holidays.push(currentEvent.valueDate.d);
                }
                // 记录补班/调休（基于 DTSTART + SUMMARY关键词）
                const s = (currentEvent.summary || '').toLowerCase();
                const isCompensate = (
                    s.includes('补班') ||
                    (s.includes('调休') && s.includes('上班')) ||
                    s.includes('上班') ||
                    s.includes('compensateday') ||
                    s.includes('compensate') ||
                    s.includes('make-up') ||
                    s.includes('make up') ||
                    s.includes('workday')
                );
                if (currentEvent.startDate && currentEvent.startDate.y === year && currentEvent.startDate.m === month && isCompensate) {
                    workdays.push(currentEvent.startDate.d);
                }
            }
            currentEvent = null;
        }
    }

    return { holidays, workdays };
}

/**
 * 计算当月"总工作日"、"已上班天数"与"今日是否为工作日"。
 * 新规则：
 * - 总工作日 = 所有周一至周五的天数 - 法定节假日 + 补班/调休日
 * - 今日是否工作日 = 是否为周一至周五且不在法定节假日中
 * - 节假日视为带薪假期，计入本月工作天数和累计工资
 */
function calcWorkingDays(year, month, restDaysConfig, holidays, workdays) {
    const daysInMonth = new Date(year, month, 0).getDate(); // 注意这里 month 为 1-12（与 new Date 保持一致传递）
    const today = new Date();
    const currentDay = today.getDate();

    let totalWorkingDays = 0;
    let workedDays = 0;
    let isTodayWorkingDay = false;
    let isTodayHoliday = false;

    // restDaysConfig：例如 [6,7] 表示周六与周日休息；Date.getDay(): 0=周日 -> 映射为7，其它 1-6 不变
    const restSet = new Set((restDaysConfig || []).map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 7));

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        const dow = date.getDay(); // 0-6，0是周日
        const dowHuman = (dow === 0) ? 7 : dow; // 1-7，人类友好

        // 检查这一天是否为法定节假日
        const isHoliday = holidays.includes(day);
        
        // 检查这一天是否为补班/调休日
        const isWorkday = workdays.includes(day);
        
        // 判断是否为工作日：周一到周五且不在法定节假日中，或者是在补班/调休日
        let isWorkingDay = false;
        if (isWorkday) {
            // 如果是补班/调休日，则为工作日
            isWorkingDay = true;
        } else if (isHoliday) {
            // 如果是法定节假日，则不是工作日
            isWorkingDay = false;
        } else if (restSet.has(dowHuman)) {
            // 如果是用户配置的休息日（如周末），则不是工作日
            isWorkingDay = false;
        } else {
            // 否则是工作日（周一到周五，非法定节假日）
            isWorkingDay = true;
        }

        if (isWorkingDay) {
            totalWorkingDays++;
            if (day <= currentDay) workedDays++;
            if (day === currentDay) isTodayWorkingDay = true;
        } else if (isHoliday && day <= currentDay) {
            // 如果是法定节假日且在今天或之前，则计入已上班天数（带薪假期）
            workedDays++;
            if (day === currentDay) {
                isTodayHoliday = true;
                isTodayWorkingDay = true; // 节假日也视为工作日（带薪假期）
            }
        }
    }

    return { totalWorkingDays, workedDays, isTodayWorkingDay, isTodayHoliday };
}

/**
 * 计算距离下一个休息日的天数
 * @param {number} year 当前年份
 * @param {number} month 当前月份（1-12）
 * @param {Array<number>} restDaysConfig 用户配置的休息日（1-7）
 * @param {Array<number>} holidays 当月法定节假日天数
 * @param {Array<number>} workdays 当月补班/调休天数
 * @param {string} icsText ICS文本，用于解析未来月份的假期和补班
 * @returns {number} 距离下一个休息日的天数
 */
function calcNextRestDay(year, month, restDaysConfig, holidays, workdays, icsText) {
    const today = new Date();

    // restDaysConfig：例如 [6,7] 表示周六与周日休息；Date.getDay(): 0=周日 -> 映射为7，其它 1-6 不变
    const restSet = new Set((restDaysConfig || []).map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 7));

    // 从今天开始，依次检查每一天是否为休息日
    let nextRestDay = null;
    let checkDate = new Date(today);

    // 最多检查30天，避免无限循环
    for (let i = 0; i < 30; i++) {
        const checkYear = checkDate.getFullYear();
        const checkMonth = checkDate.getMonth() + 1;
        const checkDay = checkDate.getDate();
        const dow = checkDate.getDay(); // 0-6，0是周日
        const dowHuman = (dow === 0) ? 7 : dow; // 1-7，人类友好

        let isRestDay = false;

        // 重新获取当月的节假日和补班信息（如果月份或年份变化）
        let currentMonthHolidays = holidays;
        let currentMonthWorkdays = workdays;
        if (checkMonth !== month || checkYear !== year) {
            // 如果月份或年份变化，重新解析对应月份的ICS
            const parsed = parseICSForMonth(icsText, checkYear, checkMonth);
            currentMonthHolidays = parsed.holidays;
            currentMonthWorkdays = parsed.workdays;
        }

        // 判断是否为休息日
        if (restSet.has(dowHuman)) {
            // 用户配置的休息日：如果不是补班/调休，则为休息日
            if (!currentMonthWorkdays.includes(checkDay)) {
                isRestDay = true;
            }
        } else {
            // 非用户配置的休息日：如果是法定假期，则为休息日
            if (currentMonthHolidays.includes(checkDay)) {
                isRestDay = true;
            }
        }

        // 如果是休息日，则返回
        if (isRestDay) {
            nextRestDay = checkDate;
            break;
        }

        // 检查下一天
        checkDate.setDate(checkDate.getDate() + 1);
    }

    // 计算距离天数
    if (nextRestDay) {
        const diffTime = nextRestDay - today;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    }

    return 0;
}

/**
 * 计算并更新状态栏文本与悬浮提示。
 * 文本：￥xxx.xx
 * 悬浮：距离下班：HH:mm:ss（并根据情况显示"已下班/未到上班时间/今日非工作日"等）
 */
async function updateStatusBar() {
    if (!statusBarItem) return;

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // 1-12

    // 读取配置
    const cfg = getConfig();
    const msMin = parseHHMMToMinutes(cfg.morningStart, 9 * 60);
    const meMin = parseHHMMToMinutes(cfg.morningEnd, 12 * 60);
    const asMin = parseHHMMToMinutes(cfg.afternoonStart, 13 * 60);
    const aeMin = parseHHMMToMinutes(cfg.afternoonEnd, 18 * 60);

    // 基本时间顺序保护（若配置异常，做顺序修正，避免负值）：
    const morningStartDate = setDateToMinutes(now, msMin);
    const morningEndDate = setDateToMinutes(now, Math.max(meMin, msMin));
    const afternoonStartDate = setDateToMinutes(now, Math.max(asMin, meMin));
    const afternoonEndDate = setDateToMinutes(now, Math.max(aeMin, asMin));

    // 拉取与解析 ICS（尝试缓存）
    let icsText = '';
    try {
        // globalState 无法在此函数直接访问，这里通过扩展上下文存储不太方便。
        // 简化处理：仅使用扩展级内存 holidayCache（activate 中初始化后可更新），
        // 若需要 globalState，请将 context 传入或在 activate 内封装。
        // 为了保持最少变更，此处直接按缓存规则决定是否重新下载。
        const nowMs = Date.now();
        if (!(holidayCache.text && holidayCache.fetchedAt && (nowMs - holidayCache.fetchedAt) < ICS_CACHE_TTL)) {
            icsText = await new Promise((resolve, reject) => {
                https.get(ICS_URL, res => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`ICS 请求失败，状态码：${res.statusCode}`));
                        return;
                    }
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                }).on('error', reject);
            });
            holidayCache = { text: icsText, fetchedAt: nowMs };
        } else {
            icsText = holidayCache.text;
        }
    } catch (err) {
        // 网络错误时，置空 ICS 文本，后续计算仅按休息日配置进行
        icsText = '';
    }

    // 解析当月假期与补班
    const { holidays, workdays } = parseICSForMonth(icsText, year, month);

    // 计算本月工作日相关数据
    const { totalWorkingDays, workedDays, isTodayWorkingDay, isTodayHoliday } = calcWorkingDays(year, month, cfg.restDays, holidays, workdays);


    // 计算"今日工资"与"距离下班时间"
    const monthlySalary = Number(cfg.monthlySalary) || 0;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const totalWorkMs = (morningEndDate - morningStartDate) + (afternoonEndDate - afternoonStartDate);

    let earned = 0;
    let statusLabel = '';
    let dailySalary = 0; // 用于"本月工资"累计计算（两位小数）

    if (!isTodayWorkingDay || totalWorkingDays <= 0 || monthlySalary <= 0 || totalWorkMs <= 0) {
        // 非工作日或配置不可用：显示为 0，并给提示
        earned = 0;
        if (isTodayHoliday) {
            statusLabel = '今天放假';
            // 节假日时，获得当日日薪
            dailySalary = monthlySalary / totalWorkingDays;
            earned = dailySalary;
        } else if (!isTodayWorkingDay) statusLabel = '今天休息';
        else if (totalWorkingDays <= 0) statusLabel = '本月总工作日为 0（请检查节假日数据与休息日配置）';
        else if (monthlySalary <= 0) statusLabel = '请在设置中配置月薪';
        else statusLabel = '时间配置异常，请检查上下班时间';
    } else {
        // 今日为工作日：计算已过工作时长比例
        let passedMs = 0;
        if (now < morningStartDate) {
            // 未到上班时间
            passedMs = 0;
            statusLabel = '未到上班时间';
        } else if (now >= morningStartDate && now <= morningEndDate) {
            // 上午工作中
            passedMs = now - morningStartDate;
            statusLabel = '上午工作中';
        } else if (now > morningEndDate && now < afternoonStartDate) {
            // 午休时间
            passedMs = morningEndDate - morningStartDate;
            statusLabel = '午休时间';
        } else if (now >= afternoonStartDate && now <= afternoonEndDate) {
            // 下午工作中
            passedMs = (morningEndDate - morningStartDate) + (now - afternoonStartDate);
            statusLabel = '下午工作中';
        } else {
            // 已下班（晚于下午结束）
            passedMs = totalWorkMs; // 视为全天完成
            statusLabel = '已下班';
        }

        dailySalary = monthlySalary / totalWorkingDays;
        const ratio = Math.max(0, Math.min(1, passedMs / totalWorkMs));
        earned = dailySalary * ratio;
        // 下班后显示整日工资
        if (now > afternoonEndDate) earned = dailySalary;
    }

    // 若前面未在工作日分支计算，则在此统一计算日薪（避免本月工资无法累计）
    if (dailySalary === 0 && monthlySalary > 0 && totalWorkingDays > 0) {
        dailySalary = monthlySalary / totalWorkingDays;
    }

    // 记录最近上下文，供金额高频刷新使用（避免每100ms解析 ICS 与月度工作日）
    lastContext = {
        morningStartDate,
        morningEndDate,
        afternoonStartDate,
        afternoonEndDate,
        totalWorkingDays,
        isTodayWorkingDay,
        isTodayHoliday,
        monthlySalary,
    };

    // 悬浮窗显示信息：
    // 1) 点击提示（新增）
    // 2) 状态（未到上班/上午工作中/午休/下午工作中/已下班/休息日/节假日）
    // 3) 距离上午结束的倒计时（HH:mm:ss）- 节假日不显示
    // 4) 距离下午结束的倒计时（HH:mm:ss）- 节假日不显示
    // 5) 月度统计
    // 每秒刷新一次，提供实时信息；仍使用"文本变更才更新"的策略，减少不必要重绘。
    const tooltipLines = [];
    tooltipLines.push('单击打开 FishTimePro 设置');
    
    if (statusLabel) tooltipLines.push(statusLabel);
    
    // 节假日时不显示距离上下班的倒计时
    if (!isTodayHoliday) {
        tooltipLines.push(`距离上午结束：${formatDiffToHMS(morningEndDate - now)}`);
        tooltipLines.push(`距离下午结束：${formatDiffToHMS(afternoonEndDate - now)}`);
    } else {
        tooltipLines.push('今天是法定节假日，享受带薪假期！');
    }
    
    // 追加两段：
    // 4) 本月实际工作天数（计算自休息日、法定节假日与补班/调休）
    // 5) 本月工资（前N-1天为整日工资 + 今天的实时进度工资，保留两位小数）
    const monthlyToDate = (dailySalary > 0)
        ? (isTodayWorkingDay ? ((workedDays - 1) * dailySalary + earned) : (workedDays * dailySalary))
        : 0;
    const monthlyToDateText = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(monthlyToDate);
    // 显示"已工作天数/本月工作天数"，其中 workedDays 包含"今天"若今天为工作日
    tooltipLines.push(`本月工作天数：${workedDays} / ${totalWorkingDays}`);
    tooltipLines.push(`本月累计工资：￥ ${monthlyToDateText}`);

    const newTooltip = tooltipLines.join('\n');
    if (newTooltip !== lastTooltipText) {
        statusBarItem.tooltip = newTooltip;
        lastTooltipText = newTooltip;
    }
}

/**
 * 仅更新状态栏金额文本（每100ms），使用最近一次的上下文。
 * 避免高频解析 ICS 与月度工作日，提高性能并呈现"连续变化"。
 */
function updateAmountText() {
    if (!statusBarItem || !lastContext) return;
    const now = new Date();
    const {
        morningStartDate,
        morningEndDate,
        afternoonStartDate,
        afternoonEndDate,
        totalWorkingDays,
        isTodayWorkingDay,
        isTodayHoliday,
        monthlySalary
    } = lastContext;

    const totalWorkMs = (morningEndDate - morningStartDate) + (afternoonEndDate - afternoonStartDate);
    let earned = 0;
    let ratio = 0; // 今日工作进度（0-1）
    
    if (isTodayHoliday) {
        // 节假日时，显示当日日薪和100%进度
        const dailySalary = monthlySalary / totalWorkingDays;
        earned = dailySalary;
        ratio = 1;
    } else if (!isTodayWorkingDay || totalWorkingDays <= 0 || monthlySalary <= 0 || totalWorkMs <= 0) {
        earned = 0;
        ratio = 0;
    } else {
        let passedMs = 0;
        if (now < morningStartDate) {
            passedMs = 0;
        } else if (now >= morningStartDate && now <= morningEndDate) {
            passedMs = now - morningStartDate;
        } else if (now > morningEndDate && now < afternoonStartDate) {
            passedMs = morningEndDate - morningStartDate;
        } else if (now >= afternoonStartDate && now <= afternoonEndDate) {
            passedMs = (morningEndDate - morningStartDate) + (now - afternoonStartDate);
        } else {
            passedMs = totalWorkMs; // 已下班，视为全天完成
        }

        const dailySalary = monthlySalary / totalWorkingDays;
        ratio = Math.max(0, Math.min(1, passedMs / totalWorkMs));
        earned = (now > afternoonEndDate) ? dailySalary : (dailySalary * ratio);
    }

    const earnedText = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(earned);
    const percentText = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ratio * 100);
    statusBarItem.text = `￥ ${earnedText}  |  ${percentText}%`;
}

module.exports = {
    activate,
    deactivate
};