import { testFn } from '../../src/main'
import { getMockCreep } from '../mock/Creep'

// 这个 it 就代表了一个测试用例
it('可以正常相加', () => {
    // 执行测试
    const result = testFn(1, 2)
    // 比较测试结果和我们的期望
    expect(result).toBe(3)
})

it('全局环境测试', () => {
    // 全局应定义了 Game
    expect(Game).toBeDefined()
    // 全局应定义了 lodash
    expect(_).toBeDefined()
    // 全局的 Memory 应该定义且包含基础的字段
    expect(Memory).toMatchObject({ rooms: {}, creeps: {} })
})

it('mock Creep 可以正常使用', () => {
    // 创建一个 creep 并指定其属性
    const creep = getMockCreep({ name: 'test', ticksToLive: 100 })

    expect(creep.name).toBe('test')
    expect(creep.ticksToLive).toBe(100)
})

/**
 * 当 source 里有能量时让 creep 执行采集
 */
 const useHarvest = function (creep: Creep, source: Source): void {
    if (source.energy > 0) creep.harvest(source)
}

it('useHarvest 可以正确调用 harvest 方法', () => {
    const mockHarvest = jest.fn()
    // 构建测试素材
    const creep = getMockCreep({ harvest: mockHarvest })
    const hasEnergySource = { energy: 100 } as Source
    const noEnergySource = { energy: 0 } as Source

    // 执行测试
    useHarvest(creep, hasEnergySource)
    useHarvest(creep, hasEnergySource)
    useHarvest(creep, noEnergySource)

    // 检查期望
    expect(mockHarvest).toBeCalledTimes(2)
    // 这两种写法结果相同
    expect(mockHarvest.mock.calls).toHaveLength(2)

    console.log(mockHarvest.mock.calls)
    // > [ [ { energy: 100 } ], [ { energy: 100 } ] ]
})