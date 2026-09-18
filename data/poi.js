/**
 * POI 字典：行程中出现的所有地点
 *
 * 字段说明：
 * - id       唯一标识，itinerary.js 里按 id 引用
 * - name     地点名称（同时作为高德地理编码的检索关键词）
 * - address  详细地址，检索更精准；留空则仅用 name 检索
 * - city     所在城市，限定检索范围，避免同名地点
 * - coords   [经度, 纬度]，由 tools/generate-routes.js 自动回填，无需手填
 * - role     anchor（行程锚点，地图上加重显示）/ spot（游玩点）
 * - kind     图标类型，影响地图标记样式
 * - note     展示在时间轴上的补充说明
 * - keyword  可选。定位不准时填高德 POI ID 或更精确的地址，强制重新解析
 *
 * 行前准备相关（可选，没有就是不需要操心）：
 * - ticket   门票。免费也写「免费」，让人一眼确认，不用去猜「没写是不是要钱」
 * - eat      附近吃什么。写具体的店名/吃食，不要写「附近有餐厅」这种废话
 * - rain     雨天替代方案（只有户外的点需要）
 *
 * 注意这里全是扁平字段，**不要嵌套对象**：tools/generate-routes.js 的 upsertCoords
 * 靠「第一个只有 } 的行」定位条目结尾，嵌套对象的闭合括号会被它误认成结尾，
 * 从而把 coords 插进嵌套结构中间写坏文件。需要结构化的数据（如预约规则）
 * 放 data/prep.js，用 poiId 引用回来。
 *
 * ⚠️ 门票价格与预约规则会变，尤其节假日。标了「以官方为准」的务必出发前再确认。
 *
 * 新增地点后直接跑 `node tools/generate-routes.js`，坐标会自动补进 coords 行。
 */
window.TRIP_POI = {
  /* ---------------- 行程锚点（固定，勿删） ---------------- */

  'airport-t3': {
    id: 'airport-t3',
    name: '武汉天河国际机场T3航站楼',
    address: '黄陂区机场大道',
    city: '武汉',
    role: 'anchor',
    kind: 'airport',
    note: '10.03 抵达 · 10.06 返程',
    coords: [114.213098, 30.768786],
    eat: 'T3 到达层有连锁快餐；赶飞机建议安检前吃完再进去',
  },

  'hotel': {
    id: 'hotel',
    name: '中交五洲皇冠酒店',
    address: '汉阳区四新大道',
    city: '武汉',
    role: 'anchor',
    kind: 'hotel',
    note: '10.03 入住 · 全程 3 晚',
    coords: [114.196077, 30.535053],
    eat: '四新大道一带以连锁餐饮和商场店为主，晚上回来饿了不愁',
  },

  /* ---------------- Day 1 · 汉口 ---------------- */

  'shanhaiguan-road': {
    id: 'shanhaiguan-road',
    name: '山海关路',
    address: '江岸区山海关路',
    city: '武汉',
    role: 'spot',
    kind: 'food',
    note: '过早一条街：鸡冠饺、糯米包油条、豆皮，10:00 前后最热闹',
    coords: [114.310208, 30.602394],
    ticket: '免费',
    eat: '鸡冠饺、糯米包油条、豆皮、糊汤粉；挑门口排本地人最多的那家',
    rain: '有棚的早点摊为主，小雨无妨',
  },

  'lihuangpi-road': {
    id: 'lihuangpi-road',
    name: '黎黄陂路',
    address: '江岸区黎黄陂路',
    city: '武汉',
    role: 'spot',
    kind: 'street',
    note: '街头博物馆，老租界建筑 + 咖啡馆；往江汉路方向走会顺路穿过咸安坊',
    coords: [114.299353, 30.587731],
    ticket: '免费',
    eat: '三镇民生甜食馆的热干面配蛋酒、洞庭街牛肉粉；整条街咖啡馆密度极高',
    rain: '露天步行街，但沿街咖啡馆和洋房可随时进去避雨，影响不大',
  },

  'bagong-fangzi': {
    id: 'bagong-fangzi',
    name: '巴公房子',
    address: '江岸区洞庭街73号',
    city: '武汉',
    role: 'spot',
    kind: 'landmark',
    note: '1910 年俄式老公寓，锐角三角形清水红砖楼；现为巴公邸酒店，公共区域可进，客房区勿入',
    coords: [114.299831, 30.586141],
    ticket: '免费（中庭展览可预约）',
    eat: '楼下的巴公小酒馆；黎黄陂路就近，选择很多',
    rain: '楼内中庭可参观，拍不了楼角全景而已',
  },

  'xianfang': {
    id: 'xianfang',
    name: '咸安坊（顺路）',
    address: '江岸区中山大道',
    city: '武汉',
    role: 'spot',
    kind: 'street',
    note: '改造后的百年里份，红砖门楼很出片；就在江汉路旁边',
    coords: [114.293535, 30.584931],
    ticket: '免费',
  },

  'jianghan-road': {
    id: 'jianghan-road',
    name: '江汉路步行街',
    address: '江岸区江汉路',
    city: '武汉',
    role: 'spot',
    kind: 'street',
    note: '百年商业街，傍晚亮灯后最好看；步行街内不通车',
    coords: [114.290521, 30.581672],
    ticket: '免费',
    eat: '蔡林记热干面、四季美汤包；街上选择极多，随便挑',
    rain: '商业街两侧店铺可随时进，雨天照常',
  },

  'hankou-beach': {
    id: 'hankou-beach',
    name: '汉口江滩',
    address: '江岸区沿江大道',
    city: '武汉',
    role: 'spot',
    kind: 'park',
    note: '晚饭后沿江散步，对岸是武昌天际线，长江灯光秀 19:00 后开启',
    coords: [114.314625, 30.607245],
    ticket: '免费',
    rain: '完全露天，雨天改回江汉路步行街逛店',
  },

  /* ---------------- Day 2 · 东湖（与 Day 3 对调而来） ---------------- */

  'hubei-museum': {
    id: 'hubei-museum',
    name: '湖北省博物馆',
    address: '武昌区东湖路160号',
    city: '武汉',
    role: 'spot',
    kind: 'museum',
    note: '曾侯乙编钟、越王勾践剑必看；需提前预约，9:00 开门，周一闭馆',
    coords: [114.365261, 30.561633],
    ticket: '免费（需预约）',
    eat: '馆内只有简餐，建议出来沿东湖路吃',
    rain: '室内，雨天照常——下雨天这里是首选避雨点',
  },

  'donghu-tingtao': {
    id: 'donghu-tingtao',
    name: '东湖听涛景区',
    address: '武昌区东湖路特1号',
    city: '武汉',
    role: 'spot',
    kind: 'park',
    note: '东湖最老的景区，离省博约 1.1 km；行吟阁、碧潭观鱼、濒湖画廊沿湖分布，免费',
    coords: [114.376688, 30.564713],
    ticket: '免费',
    eat: '东湖路沿线餐馆多；景区内小卖部偏贵，自己带瓶水',
    rain: '环湖露天步道，雨天改回湖北省博物馆（相距 1.1 km）',
  },

  'wuhan-university': {
    id: 'wuhan-university',
    name: '武汉大学',
    address: '武昌区八一路299号',
    city: '武汉',
    role: 'spot',
    kind: 'campus',
    note: '樱花季之外同样好逛：老斋舍、樱顶、珞珈山；节假日需预约入校',
    coords: [114.364514, 30.536243],
    ticket: '免费（需预约入校）',
    eat: '校内食堂要校园卡；出校后到八一路或街道口吃',
    rain: '校园靠步行串联，雨天可压缩行程，直接去楚河汉街',
  },

  'lingbomen': {
    id: 'lingbomen',
    name: '凌波门',
    address: '武昌区东湖南路',
    city: '武汉',
    role: 'spot',
    kind: 'park',
    note: '武大临东湖的栈桥，看湖面落日；栈道狭窄注意安全',
    coords: [114.363807, 30.545119],
    ticket: '免费',
    rain: '栈桥露天且长年青苔湿滑，雨天建议直接跳过，早点去楚河汉街',
  },

  'chuhe-hanjie': {
    id: 'chuhe-hanjie',
    name: '楚河汉街',
    address: '武昌区中北路楚河汉街',
    city: '武汉',
    role: 'spot',
    kind: 'street',
    note: '沿楚河的商业街，夜里灯光和游船都好看，适合收尾吃晚饭',
    coords: [114.340331, 30.554925],
    ticket: '免费',
    eat: '街上湖北菜与连锁餐饮都有；临河的馆子环境更好，适合收尾这顿',
    rain: '商业街店铺密集可躲雨，雨天照常，是行程里的雨天兜底点',
  },

  /* ---------------- Day 3 · 武昌老城（与 Day 2 对调而来） ---------------- */

  'tanhualin': {
    id: 'tanhualin',
    name: '昙华林',
    address: '武昌区昙华林',
    city: '武汉',
    role: 'spot',
    kind: 'street',
    note: '文艺老街 + 仁济医院老建筑，建议 1.5 小时',
    coords: [114.308791, 30.55194],
    ticket: '免费',
    eat: '街边咖啡馆和文创小店；走下山就是粮道街，正餐留给那边',
    rain: '坡道露天，雨天可缩短，直接下山去粮道街',
  },

  'liangdao-street': {
    id: 'liangdao-street',
    name: '粮道街',
    address: '武昌区粮道街',
    city: '武汉',
    role: 'spot',
    kind: 'food',
    note: '武昌小吃一条街：赵师傅红油热干面、油饼包烧麦都在这条街上',
    coords: [114.310451, 30.547408],
    ticket: '免费',
    eat: '赵师傅红油热干面、油饼包烧麦、糯米包油条——中午当正餐吃完全够',
    rain: '小吃摊多带棚，小雨照常',
  },

  'huanghelou': {
    id: 'huanghelou',
    name: '黄鹤楼',
    address: '武昌区蛇山西山坡特1号',
    city: '武汉',
    role: 'spot',
    kind: 'landmark',
    note: '江南三大名楼，登顶可俯瞰长江大桥；建议线上提前预约',
    coords: [114.305298, 30.543475],
    ticket: '70 元起',
    eat: '出园后往司门口、大成路走，小吃集中',
    rain: '登楼看不到远景，但楼内可避雨，不算白来',
  },

  'hongqiang': {
    id: 'hongqiang',
    name: '黄鹤楼红墙',
    address: '武昌区黄鹤楼东路',
    city: '武汉',
    role: 'spot',
    kind: 'landmark',
    note: '网红机位，就在黄鹤楼外围墙边，红墙与楼同框；排队太长不必硬等',
    coords: [114.302691, 30.547544],
    ticket: '免费',
    rain: '露天机位，雨天直接跳过',
  },

  'yangtze-bridge': {
    id: 'yangtze-bridge',
    name: '武汉长江大桥',
    address: '武昌区临江大道',
    city: '武汉',
    role: 'spot',
    kind: 'landmark',
    note: '傍晚走桥面人行道看日落，两岸灯光亮起后反差最好看',
    coords: [114.292874, 30.547225],
    ticket: '免费',
    rain: '桥面露天且江风大，雨天别上桥，直接从中华路码头坐轮渡过江',
  },

  /* 轮渡过江用的一对码头（武中线：中华路1号码头 ↔ 武汉关1号码头，票价 1.5 元） */

  'zhonghualu-matou': {
    id: 'zhonghualu-matou',
    name: '中华路码头',
    address: '武昌区临江大道江滩78号',
    city: '武汉',
    role: 'spot',
    kind: 'landmark',
    note: '武中线武昌侧登船点，紧邻长江大桥与户部巷；末班 20:00，赶 19:30 那班最稳',
    coords: [114.294686, 30.550602],
    ticket: '轮渡 1.5 元（武中线）',
    eat: '紧邻户部巷小吃街，上船前可以垫一口',
    rain: '船舱有顶棚，雨天照常——雨天反而更推荐坐船过江',
  },

  'wuhanguan-matou': {
    id: 'wuhanguan-matou',
    name: '武汉关码头',
    address: '江汉区沿江大道江滩14号',
    city: '武汉',
    role: 'spot',
    kind: 'landmark',
    note: '武中线汉口侧下船点，上岸就是江汉路与汉口江滩；打车回酒店约 25 分钟',
    coords: [114.29818, 30.575127],
    ticket: '轮渡 1.5 元（武中线）',
    eat: '上岸就是江汉路，吃的很多',
  },

  /* ---------------- Day 4 · 汉阳（返程日，就近安排） ---------------- */

  'guiyuan-temple': {
    id: 'guiyuan-temple',
    name: '归元禅寺',
    address: '汉阳区归元寺路20号',
    city: '武汉',
    role: 'spot',
    kind: 'temple',
    note: '汉阳香火最盛的禅寺，五百罗汉堂必看；离酒店近，返程日上午正合适',
    coords: [114.260079, 30.545484],
    ticket: '10 元（另有来源称 20 元，以现场为准）',
    eat: '寺内素斋；周边汉阳小吃店不少',
    rain: '以殿堂为主可避雨，雨天照常',
  },

  'hanyangzao': {
    id: 'hanyangzao',
    name: '汉阳造创意园',
    address: '汉阳区龟山北路1号',
    city: '武汉',
    role: 'spot',
    kind: 'park',
    note: '老厂房改造的文创园，有咖啡馆和展馆，轻松逛 1 小时',
    coords: [114.268285, 30.556247],
    ticket: '免费',
    eat: '园区里的咖啡馆和餐厅，午饭就在这解决',
    rain: '园区有室内展馆和咖啡馆，雨天可照常',
  },

  'yuehu-park': {
    id: 'yuehu-park',
    name: '月湖公园',
    address: '汉阳区月湖',
    city: '武汉',
    role: 'spot',
    kind: 'park',
    note: '琴台旁的湖景公园，去机场前散步消食',
    coords: [114.260166, 30.557715],
    ticket: '免费',
    rain: '露天，雨天直接跳过（它本来就是备选）',
  },

  'hankouli': {
    id: 'hankouli',
    name: '汉口里',
    address: '硚口区园博园东路',
    city: '武汉',
    role: 'spot',
    kind: 'street',
    note: '园博园东门旁的汉味街区，离机场近，返程前顺路吃顿晚饭',
    coords: [114.225873, 30.618327],
    ticket: '免费',
    eat: '汉味街区：热干面、豆皮、糊汤粉都有',
  }
};
