# 奶蛙动作 GIF 抠图：去背景 → 透明 WebP 动画
# 用法: python tools/cut_naiwa.py <white|frog> <in.gif> <out.webp>
# 依赖: pillow numpy scipy
import sys
import numpy as np
from PIL import Image, ImageSequence, ImageFilter
from scipy import ndimage


def rgb2hsv(a):  # a: float32 HxWx3 in [0,1] -> h,s,v each [0,1]
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx = a.max(-1)
    mn = a.min(-1)
    diff = mx - mn
    h = np.zeros_like(mx)
    m = diff > 1e-6
    d = np.where(m, diff, 1)
    idx = m & (mx == r)
    h[idx] = ((g - b)[idx] / d[idx]) % 6
    idx = m & (mx == g)
    h[idx] = (b - r)[idx] / d[idx] + 2
    idx = m & (mx == b)
    h[idx] = (r - g)[idx] / d[idx] + 4
    h /= 6.0
    s = np.where(mx > 1e-6, diff / np.where(mx > 1e-6, mx, 1), 0)
    return h, s, mx


def center_component(mask):
    """保留质心最接近整帧中心的连通块（白底模式用）"""
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask
    H, W = mask.shape
    cy, cx = H / 2, W / 2
    best, bd = 0, 1e18
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    for i in range(1, n + 1):
        if sizes[i - 1] < 40:
            continue
        ys, xs = np.nonzero(lab == i)
        d = (ys.mean() - cy) ** 2 + (xs.mean() - cx) ** 2
        if d < bd:
            bd, best = d, i
    if best == 0:
        best = int(np.argmax(sizes)) + 1
    return lab == best


def largest_component(mask):
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def make_mask(rgb, mode):
    a = rgb.astype(np.float32) / 255.0
    if mode == 'white':
        d = np.sqrt(((1.0 - a) ** 2).sum(-1))  # 距白色的欧氏距离
        return d > 0.11
    # frog: 黄身（放宽饱和度抓运动模糊边缘）+ 奶油肚皮
    h, s, v = rgb2hsv(a)
    yellow = (h > 0.07) & (h < 0.22) & (s > 0.30) & (v > 0.30)
    cream = (h > 0.07) & (h < 0.22) & (s > 0.10) & (s <= 0.62) & (v > 0.68)
    return yellow | cream


def refine_frog(mask):
    """frog 模式：厚度核取主体 → 限量重建 → 切除长卷须（马路黄线）
    不用整体强腐蚀，避免把运动模糊的手脚一起削掉"""
    mask = ndimage.binary_opening(mask, iterations=1)
    dist = ndimage.distance_transform_edt(mask)
    thick = mask & (dist >= 4.0)          # 厚度核：细线无处遁形，身体四肢都有粗芯
    seed = largest_component(thick)
    if seed.sum() < 100:                  # 极端模糊帧降级
        seed = largest_component(ndimage.binary_erosion(mask, iterations=2))
    final = mask & ndimage.binary_dilation(seed, iterations=8)
    lab, n = ndimage.label(final)
    if n:  # 只保留与芯相连的部分（远处土坡/噪点丢弃）
        keep = np.unique(lab[ndimage.binary_dilation(seed, iterations=2)])
        keep = keep[keep > 0]
        final = np.isin(lab, keep)
    # 切除长卷须：>55px 的细长结构且只有细连接头（黄线贴脚的情况），保留 5px 连接头
    dist2 = ndimage.distance_transform_edt(final)
    thin = final & (dist2 < 3.0)
    body = final & ~thin
    lab2, n2 = ndimage.label(thin)
    for i in range(1, n2 + 1):
        comp = lab2 == i
        if comp.sum() < 40:
            continue
        ys, xs = np.nonzero(comp)
        if max(ys.max() - ys.min(), xs.max() - xs.min()) > 55:
            cap = ndimage.binary_dilation(body, iterations=5)
            final &= ~(comp & ~cap)
    return final


def cut(src, dst, mode):
    gif = Image.open(src)
    durs = []
    for i in range(gif.n_frames):
        gif.seek(i)
        durs.append(gif.info.get('duration', 100))
    frames = ImageSequence.all_frames(gif, lambda f: f.convert('RGBA'))

    out = []
    for fr in frames:
        arr = np.array(fr)
        rgb = arr[..., :3].astype(np.float32)
        mask = make_mask(rgb, mode)
        mask = refine_frog(mask) if mode == 'frog' else center_component(mask)
        mask = ndimage.binary_fill_holes(mask)      # 眼睛/深色描边等封闭区补回
        mask = ndimage.binary_dilation(mask, iterations=1)  # 吃进 1px 描边
        alpha = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.1))
        arr[..., 3] = np.minimum(arr[..., 3], np.array(alpha))
        out.append(Image.fromarray(arr, 'RGBA'))

    out[0].save(dst, save_all=True, append_images=out[1:], duration=durs,
                loop=0, quality=86, method=4)
    print(f'{src} -> {dst}: {len(out)} 帧')


if __name__ == '__main__':
    cut(sys.argv[2], sys.argv[3], sys.argv[1])
