const regionDisplayNames = typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames([ 'zh-CN' ], { type: 'region' })
    : null

const exactTranslations = new Map(Object.entries({
    "Bruno's": 'Bruno 的作品集',
    "Bruno's Home": 'Bruno 的主页',
    "Bruno Simon's creative portfolio": 'Bruno Simon 的创意作品集',
    'Interact': '互动',
    'Unstuck': '脱困',
    'Your message here': '在这里输入留言',
    'Welcome!': '欢迎！',
    'My name is': '我叫',
    ", and I'm a": '，我是一名',
    'creative developer': '创意开发者',
    '(mostly for the web).': '（主要从事 Web 开发）。',
    'This is my portfolio. Please drive around to learn more about me and discover the many secrets of this world.': '这是我的作品集。开车四处探索，了解更多关于我的信息，并发现这个世界隐藏的秘密。',
    "And don't break anything!": '还有，别撞坏东西！',
    'Options': '设置',
    'Audio': '音频',
    'Toggles sound': '切换声音',
    'Quality': '画质',
    'Toggles some effects': '切换部分特效',
    'Low': '低',
    'High': '高',
    "I'm stuck!": '我被卡住了！',
    'Teleports you to the closest respawn': '传送到最近的重生点',
    'Respawn': '重生',
    'Reset': '重置',
    'Resets every object': '重置所有物体',
    'Renderer': '渲染器',
    'Best for performance': '性能最佳',
    'Server': '服务器',
    'Pending': '连接中',
    'Online': '在线',
    'Offline': '离线',
    'Your browser is': '你的浏览器',
    'not compatible': '不兼容',
    'with WebGPU resulting in performance loss': 'WebGPU，因此性能会有所下降',
    'Enjoy the': '可以使用',
    'multiplayer': '多人在线',
    'features': '功能',
    'Should be back soon': '预计很快恢复',
    'Mouse Keyboard': '键盘鼠标',
    'Mobile Tablet': '手机/平板',
    'Gamepad': '游戏手柄',
    'or': '或',
    'Move around': '移动',
    'Boost': '加速',
    'Brake': '刹车',
    'Jump': '跳跃',
    'Map': '地图',
    'Mute': '静音',
    'Post a whisper': '发布留言',
    'Activate hydraulics': '启动液压悬挂',
    'LEFT CLICK (DRAG)': '鼠标左键（拖动）',
    'Move camera': '移动镜头',
    'Honk': '鸣笛',
    'One finger': '单指',
    'Move the car': '控制车辆',
    'Two fingers': '双指',
    'Move camera / zoom': '移动镜头/缩放',
    'Tap (on the car)': '点击车辆',
    'Interact / Exit': '互动/退出',
    'Accelerate': '前进加速',
    'Backward accelerate': '倒车加速',
    'Hydraulics': '液压悬挂',
    'Joystick Left': '左摇杆',
    'Joystick Left (press)': '按下左摇杆',
    'Turn wheels': '转向',
    'Joystick Right': '右摇杆',
    'Joystick Right (press)': '按下右摇杆',
    'Zoom in/out': '放大/缩小',
    'Select': '选择键',
    'Start': '开始键',
    'Pause': '暂停',
    'Achievements': '成就',
    'Rewards': '奖励',
    'Unlock at': '解锁条件：',
    'Reset achievements': '重置成就',
    'Are you sure?': '确定要重置吗？',
    'Definitely?': '真的确定吗？',
    'Done!': '已重置！',
    'Circuit': '赛道',
    "Server currently offline. Scores can't be saved.": '服务器当前离线，成绩无法保存。',
    'Server currently offline': '服务器当前离线',
    'No score yet today': '今日暂无成绩',
    'Resets in': '距离重置还有',
    'Restart': '重新开始',
    'End': '结束',
    'Controls': '操作说明',
    'Leave a whisper': '留下一条留言',
    'Whispers are messages left by visitors.': '留言是访客留下的信息。',
    '- Everyone can see them': '- 所有人都能看到',
    '- New whispers remove old ones (max 30)': '- 新留言会替换旧留言（最多 30 条）',
    '- One whisper per user': '- 每位用户只能留一条',
    '- Choose a flag': '- 可以选择旗帜',
    '- No slur!': '- 禁止侮辱性内容！',
    '- Max 30 characters': '- 最多 30 个字符',
    'Search…': '搜索…',
    'Search...': '搜索…',
    'No result': '无结果',
    'Your message': '你的留言',
    'Behind the scene': '幕后制作',
    'Thank you for visiting my portfolio!': '感谢你访问我的作品集！',
    'If you are curious about the stack and how I built this project, here’s everything you need to know.': '想了解技术栈以及这个项目的制作过程，下面是全部信息。',
    'Three.js Journey': 'Three.js Journey',
    'Devlogs': '开发日志',
    'Source code': '源代码',
    'Musics': '音乐',
    'Some more links': '更多链接',
    'Physics library ⇒': '物理引擎 ⇒',
    'Audio library ⇒': '音频库 ⇒',
    'Fonts ⇒': '字体 ⇒',
    'Your time': '你的成绩',
    "Sorry, you didn't make it to the top 10.": '很遗憾，你未进入前 10 名。',
    'Submit': '提交',
    'Public server': '公共服务器',
    'Come hang out with the community': '来和社区成员一起交流',
    ', show us your projects and ask us anything': '，展示你的项目，也可以向大家提问',
    'Join server': '加入服务器',
    'Private messages': '私信',
    'Contact me directly.': '直接联系我。',
    'I have to warn you, I try to answer everyone, but it might take a while.': '提前说明：我会尽量回复每个人，但可能需要一些时间。',
    'Start chating': '开始聊天',
    'Projects': '项目',
    'Lab': '实验室',
    'Career': '职业经历',
    'Social': '社交平台',
    'Cookie': '曲奇',
    'Cookies': '曲奇',
    'Bowling': '保龄球',
    'Altar': '祭坛',
    'Toilet': '洗手间',
    'Time machine': '时间机器',
    'Time Machine': '时间机器',
    'Home': '主页',
    'Res(e)t': '重置',
    'Open': '打开',
    'Close': '关闭',
    'Previous': '上一个',
    'Next': '下一个',
    'OFFLINE': '离线',
    'NO SCORE YET TODAY': '今日暂无成绩',
    'now': '现在',
    'developer': '开发者',
    'formater': '讲师',
    'WebGL developer': 'WebGL 开发者',
    'Front developer': '前端开发者',
    'Black Hole': '黑洞',
    'Infinite World': '无限世界',
    'My Room in 3D': '我的 3D 房间',
    'Particles System': '粒子系统',
    'Stylized Low Poly': '风格化低多边形',
    'Holographic terrain': '全息地形',
    'Woodkid Volcano Robot': 'Woodkid 火山机器人',
    'Bounce Friday': '弹跳星期五',
    'VFX flames': 'VFX 火焰',
    'VFX tornado': 'VFX 龙卷风',
    'DOOM Portal': 'DOOM 传送门',
    'Organic Sphere': '有机球体',
    'Attractors': '吸引子',
    'Birch Tree': '白桦树',
    'Oak Tree': '橡树',
    'Cherry Tree': '樱花树',
    'Accept cookie': '接受曲奇',
    'Start race!': '开始比赛！',
    'Mail': '邮件',
    'Youtube': 'YouTube',
    'here': '这里',
    'Check every project in the': '查看',
    'projects': '项目',
    'lab': '实验室',
    'area.': '区域中的每个项目。',
    'Accept': '接受',
    'cookies.': '块曲奇。',
    'Reach': '达到',
    '15 meters': '15 米',
    'high.': '高度。',
    'Finish a race in less than': '用时少于',
    '30s': '30 秒',

    'I’m going on an adventure!': '我要去冒险了！',
    'Get out of the landing area.': '离开起始区域。',
    'Traveler': '旅行者',
    'Vist every area.': '访问每一个区域。',
    'But can you fix the wifi?': '但你会修 Wi-Fi 吗？',
    'Check every project in the projects area.': '查看项目区域中的每个项目。',
    "I'm a bit of a scientist myself": '我也算半个科学家',
    'Check every project in the lab area.': '查看实验室区域中的每个项目。',
    'Wake & bake': '醒来就开吃',
    'Accept 1 cookies.': '接受 1 块曲奇。',
    'Making some dough': '开始攒面团',
    'Accept 10 cookies.': '接受 10 块曲奇。',
    'So baked right now': '现在烤得正好',
    'Accept 100 cookies.': '接受 100 块曲奇。',
    'Cookie Clicker': '曲奇点击器',
    'Accept 1000 cookies.': '接受 1000 块曲奇。',
    "It's About Sending A Message": '重要的是传递信息',
    'Post a whisper.': '发布一条留言。',
    'Under the sea': '海底世界',
    'Go make friend with the fishes.': '去和鱼儿交个朋友。',
    'Turtle': '四脚朝天',
    'Get upside down.': '把车翻过来。',
    'Teeth first': '车头先着地',
    'Do a front flip and land on your 4 wheels.': '完成前空翻并四轮着地。',
    'Flip of faith': '信仰后空翻',
    'Do a back flip and land on your 4 wheels.': '完成后空翻并四轮着地。',
    'Lowrider': '低底盘',
    'Use the vehicle suspensions.': '使用车辆液压悬挂。',
    'Honk me like one of your french driver.': '像法国司机一样鸣笛。',
    'Great Explosion Murder God Dynamight': '爆破之神',
    'Blow up every explosive crate.': '炸毁所有爆炸箱。',
    'Limit the sky': '天空才是极限',
    'Reach 15 meters high.': '达到 15 米高度。',
    "F*** it, dude. Let's go bowling": '算了，去打保龄球吧',
    'Accomplished a strike.': '完成一次全中。',
    'Do not disturb': '请勿打扰',
    'Knock down the latrine.': '撞倒厕所。',
    'Participation medal': '参与奖章',
    'Finish a race.': '完成一场比赛。',
    'KA-CHOW!': '闪电加速！',
    'Finish a race in less than 30s.': '在 30 秒内完成比赛。',
    'Early Bird gets the Worm': '早起的鸟儿有虫吃',
    'Make it to the leaderboard.': '进入排行榜。',
    'Don’t you have work to do?': '你不用工作吗？',
    'Spend a full day cycle here in one go.': '一次连续经历完整的昼夜循环。',
    'Baby step': '小小一步',
    'Drive 1km.': '驾驶 1 公里。',
    'Are we there yet?': '我们到了吗？',
    'Drive 10km.': '驾驶 10 公里。',
    'Honey, I’m home!': '亲爱的，我回来了！',
    'Drive 100km.': '驾驶 100 公里。',
    'One for the god of Chaos': '献给混沌之神',
    'Sacrifice yourself into the altar.': '在祭坛上献祭自己。',
    'Witness me!': '见证我！',
    'Witness a cataclysm': '见证一次灾变',
    'Do you want to build a snowman?': '想堆个雪人吗？',
    'Witness snowy weather.': '遇到下雪天气。',
    'I’m singing in the rain': '我在雨中歌唱',
    'Witness a rainy weather.': '遇到下雨天气。',
    '1.21 Gigawatts!': '1.21 吉瓦！',
    'Get hit by a lightning.': '被闪电击中。',
    'Gamer instinct': '玩家本能',
    'What did you expect? A treasure?': '你期待什么？宝藏吗？',
    'You’re my only fan': '你是我唯一的粉丝',
    'Spawn a fan.': '生成一个风扇。',
    'Clean your room': '收拾房间',
    'Put back everything as it was.': '把所有东西恢复原样。',
    'Revolution!': '革命！',
    'Tear that statue down.': '推倒那座雕像。',
    'Up up down down…': '上上下下左右左右……',
    'You know the rest.': '后面的你知道。',
    "It's not a bug, it's a feature": '这不是 Bug，这是特性',
    'Access the debug UI.': '打开调试界面。',
    'Hacker': '黑客',
    'This one can’t be achieved.': '这个成就无法正常获得。'
}))

const phraseTranslations = [
    ['I’ve been making devlogs since the very start of this portfolio and you can find them all on my', '我从制作这个作品集之初就一直在记录开发日志，全部内容都可以在我的'],
    ['If you want to learn Three.js, I got you covered with this', '想学习 Three.js，可以看看我的'],
    ['It contains everything you need to start building awesome stuff with Three.js (and much more).', '课程包含使用 Three.js 创作优秀作品所需的一切，而且远不止这些。'],
    ['is the library I’m using to render this 3D world.', '是我用来渲染这个 3D 世界的库。'],
    ['It was created by', '它由'],
    [', followed by hundreds of awesome developers, one of which being Sunag', '创建，并由数百位优秀开发者共同维护，其中包括 Sunag'],
    ['who added', '，他加入了'],
    [', enabling the use of both WebGL and WebGPU, making this portfolio possible.', '，使 WebGL 与 WebGPU 可以同时使用，也让这个作品成为可能。'],
    ['huge course', '大型课程'],
    ['Youtube channel', 'YouTube 频道'],
    ['The code is available on', '源代码发布在'],
    ['under', '采用'],
    ['MIT license', 'MIT 许可证'],
    ['Even the Blender files are there, so have fun!', 'Blender 文件也在其中，尽情探索吧！'],
    ["For security reasons, I’m not sharing the server code, but the portfolio works without it.", '出于安全原因，我没有公开服务器端代码，但作品在没有服务器的情况下也能运行。'],
    ['The music you hear was made especially for this portfolio by the awesome Kounine', '你听到的音乐由优秀的 Kounine 专门为这个作品创作'],
    ['They are now under', '这些音乐现采用'],
    ['CC0 license', 'CC0 许可证'],
    ['meaning you can do whatever you want with them!', '你可以自由使用它们！'],
    ['Download them', '下载地址'],
    ['Unlock at ', '解锁条件：'],
    ['Resets in ', '距离重置还有 ']
].sort((a, b) => b[0].length - a[0].length)

export function translateText(value)
{
    if(typeof value !== 'string' || !/[A-Za-z]/.test(value))
        return value

    const leading = value.match(/^\s*/)?.[0] ?? ''
    const trailing = value.match(/\s*$/)?.[0] ?? ''
    let text = value.slice(leading.length, value.length - trailing.length)

    const countryMatch = text.match(/^.+\s+\(([a-z]{2})\)$/i)
    if(countryMatch && regionDisplayNames)
    {
        const code = countryMatch[1].toUpperCase()
        const name = regionDisplayNames.of(code)
        if(name)
            return `${leading}${name} (${countryMatch[1].toLowerCase()})${trailing}`
    }

    if(exactTranslations.has(text))
        return leading + exactTranslations.get(text) + trailing

    for(const [ source, target ] of phraseTranslations)
        text = text.split(source).join(target)

    text = text
        .replace(/(\d+)\s*h\b/g, '$1小时')
        .replace(/(\d+)\s*(?:min|m)\b/g, '$1分钟')
        .replace(/(\d+)\s*s\b/g, '$1秒')
        .replace(/\bOFFLINE\b/g, '离线')
        .replace(/\bNO SCORE YET TODAY\b/g, '今日暂无成绩')

    text = text.replace(/^in\s+(.+)$/, '还有 $1')

    return leading + text + trailing
}

function patchCanvasPrototype(prototype)
{
    if(!prototype || prototype.__zhCnPatched)
        return

    for(const methodName of [ 'fillText', 'strokeText', 'measureText' ])
    {
        const original = prototype[methodName]
        if(typeof original !== 'function')
            continue

        Object.defineProperty(prototype, methodName, {
            configurable: true,
            writable: true,
            value(text, ...args)
            {
                const translated = typeof text === 'string' ? translateText(text) : text
                return original.call(this, translated, ...args)
            }
        })
    }

    Object.defineProperty(prototype, '__zhCnPatched', {
        configurable: false,
        enumerable: false,
        value: true
    })
}

function patchCanvasText()
{
    if(typeof CanvasRenderingContext2D !== 'undefined')
        patchCanvasPrototype(CanvasRenderingContext2D.prototype)

    if(typeof OffscreenCanvasRenderingContext2D !== 'undefined')
        patchCanvasPrototype(OffscreenCanvasRenderingContext2D.prototype)
}

function translateElement(element)
{
    if(!(element instanceof Element))
        return

    for(const attribute of [ 'placeholder', 'title', 'aria-label', 'alt' ])
    {
        if(element.hasAttribute(attribute))
        {
            const current = element.getAttribute(attribute)
            const translated = translateText(current)
            if(translated !== current)
                element.setAttribute(attribute, translated)
        }
    }
}

function translateTree(root)
{
    if(!root)
        return

    if(root.nodeType === Node.TEXT_NODE)
    {
        const parent = root.parentElement
        if(parent?.closest('script, style, noscript, textarea, [data-no-localize]'))
            return

        const translated = translateText(root.nodeValue)
        if(translated !== root.nodeValue)
            root.nodeValue = translated
        return
    }

    if(root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)
        return

    if(root.nodeType === Node.ELEMENT_NODE)
        translateElement(root)

    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
    )

    let node = walker.nextNode()
    while(node)
    {
        if(node.nodeType === Node.TEXT_NODE)
        {
            const parent = node.parentElement
            if(!parent?.closest('script, style, noscript, textarea, [data-no-localize]'))
            {
                const translated = translateText(node.nodeValue)
                if(translated !== node.nodeValue)
                    node.nodeValue = translated
            }
        }
        else
        {
            translateElement(node)
        }

        node = walker.nextNode()
    }
}

function translateTitle(value)
{
    if(typeof value !== 'string')
        return value

    if(value === "Bruno's" || value === 'Bruno')
        return 'Bruno 的作品集'

    if(value.startsWith('Bruno'))
        return value.replace(/^Bruno/, 'Bruno 的作品集')

    return translateText(value)
}

function patchDocumentTitle()
{
    if(typeof Document === 'undefined' || typeof document === 'undefined')
        return

    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'title')
    if(!descriptor?.get || !descriptor?.set)
        return

    Object.defineProperty(document, 'title', {
        configurable: true,
        get()
        {
            return descriptor.get.call(document)
        },
        set(value)
        {
            descriptor.set.call(document, translateTitle(value))
        }
    })

    document.title = document.title
}

function updateMetadata()
{
    document.documentElement.lang = 'zh-CN'

    const description = 'Bruno Simon 的创意作品集'
    const selectors = [
        'meta[name="description"]',
        'meta[itemprop="description"]',
        'meta[name="twitter:description"]',
        'meta[property="og:description"]'
    ]

    for(const selector of selectors)
    {
        const element = document.querySelector(selector)
        if(element)
            element.setAttribute('content', description)
    }

    const appTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]')
    if(appTitle)
        appTitle.setAttribute('content', 'Bruno 的作品集')
}

function observeDom()
{
    translateTree(document.documentElement)

    const observer = new MutationObserver((mutations) =>
    {
        for(const mutation of mutations)
        {
            if(mutation.type === 'characterData')
            {
                translateTree(mutation.target)
            }
            else if(mutation.type === 'attributes')
            {
                translateElement(mutation.target)
            }
            else
            {
                for(const node of mutation.addedNodes)
                    translateTree(node)
            }
        }
    })

    observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [ 'placeholder', 'title', 'aria-label', 'alt' ]
    })
}

patchCanvasText()

if(typeof document !== 'undefined')
{
    patchDocumentTitle()

    const start = () =>
    {
        updateMetadata()
        observeDom()
    }

    if(document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', start, { once: true })
    else
        start()
}
