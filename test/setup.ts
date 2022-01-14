import { log } from 'console'
global.console.log = log

import { refreshGlobalMock } from './mock'
import { resetServer, stopServer } from './serverUtils'

// 先进行环境 mock
refreshGlobalMock()
// 然后在每次测试用例执行前重置 mock 环境
beforeEach(refreshGlobalMock)
// 每次测试用例执行完后重置服务器
afterEach(resetServer)
// 所有测试完成后关闭服务器
afterAll(stopServer)