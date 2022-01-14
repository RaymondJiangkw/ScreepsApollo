import { getMyCode } from '../moduleUtils'
import { getServer } from '../serverUtils'

it('日志记录测试', async () => {
    const server = await getServer()
    await server.world.stubWorld()

    const modules = {
        main: `module.exports.loop = function() {
            console.log('Tick!',Game.time);
            Memory[Game.time] = Game.time
        };`
    };

    await server.world.addBot({ username: 'bot 启动', room: 'W0N1', x: 25, y: 25, modules });

    for (let i = 0; i < 10; i++) {
        await server.tick()
    }
})

it('mockup 上手', async () => {
    // 初始化服务器
    const server = await getServer()
    // 创建一个基础的 9 房间世界，包含 source 和 controller
    await server.world.stubWorld()

    // 设置 bot 的代码
    const modules = await getMyCode()
    // 设置 bot 的名称和初始位置
    const bot = await server.world.addBot({
        username: 'bot',
        room: 'W0N1', x: 25, y: 25,
        modules
    })

    // 监控 bot 控制台并打印输出
    bot.on('console', logs => logs.forEach(console.log))

    // 启动服务器并运行两个 tick
    await server.start()
    await server.tick()
    await server.tick()
}, 10000)