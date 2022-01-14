// 测试套件: 用build方法从入口文件进行构建, 得到可以在mockup中执行的代码对象。

import { resolve } from 'path'
import { getServer } from '@test/serverUtils'
import { build } from '@test/moduleUtils'

it('getRoom 可以输出房间名到控制台', async () => {
    const server = await getServer()
    await server.world.stubWorld()

    const spawnRoomName = 'W1N1'

    // 从入口文件构建并添加进 bot
    const modules = await build(resolve(__dirname, './main.ts'))
    const bot = await server.world.addBot({ username: 'getRoom 测试', room: spawnRoomName, x: 25, y: 25, modules })

    // 断言 console 输出并跑 tick
    bot.on('console', logs => expect(logs).toEqual([spawnRoomName]))
    await server.tick()
}, 10000)