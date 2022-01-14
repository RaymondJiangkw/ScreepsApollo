import { errorMapper } from './modules/errorMapper'

/**
 * 接受两个数字并相加
 */
export const testFn = function (num1: number, num2: number): number {
    return num1 + num2
}

export const loop = errorMapper(() => {
    console.log("Hello World");
})