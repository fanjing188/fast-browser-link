"""用标准库栅格化本项目的几何SVG；只支持明确的几何指令，遇未知元素立即失败。"""
import argparse
import json
from pathlib import Path
import re
import struct
import xml.etree.ElementTree as ET
import zlib

ROOT=Path(__file__).resolve().parents[1]


def polygons(data):
    tokens=re.findall(r'[MLHVZ]|-?\d+(?:\.\d+)?',data)
    if re.sub(r'[MLHVZ\s,\d.\-]','',data):raise ValueError('unsupported SVG path')
    paths=[];points=[];position=[0.,0.];index=0;command=None
    while index<len(tokens):
        if tokens[index].isalpha():command=tokens[index];index+=1
        if command=='Z':
            if points:paths.append(points);points=[]
            command=None;continue
        if command in ('M','L'):
            if command=='M' and points:paths.append(points);points=[]
            position=list(map(float,tokens[index:index+2]));index+=2;command='L'
        elif command in ('H','V'):
            position[0 if command=='H' else 1]=float(tokens[index]);index+=1
        else:raise ValueError('unsupported path command')
        points.append(tuple(position))
    if points:paths.append(points)
    return paths


def inside(points,x,y):
    odd=False
    for (ax,ay),(bx,by) in zip(points,points[1:]+points[:1]):
        if (ay>y)!=(by>y) and x<(bx-ax)*(y-ay)/(by-ay)+ax:odd=not odd
    return odd


def shapes(source):
    root=ET.parse(source).getroot();box=list(map(float,root.attrib['viewBox'].split()));result=[]
    if box[:2]!=[0,0] or box[2]!=box[3]:raise ValueError('square zero-based viewBox required')
    for node in root:
        kind=node.tag.split('}')[-1];attrs=node.attrib
        fill=attrs.get('fill',root.attrib.get('fill','#000'))
        if fill=='none':continue
        if not re.fullmatch(r'#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?',fill):raise ValueError('explicit solid fill required')
        if len(fill)==4:fill='#'+''.join(c*2 for c in fill[1:])
        rgb=tuple(bytes.fromhex(fill[1:]))
        if kind=='path':
            paths=polygons(attrs['d']);test=lambda x,y,paths=paths:any(inside(p,x,y) for p in paths)
        elif kind=='rect':
            left,top,width,height,rx=(float(attrs.get(key,0)) for key in ('x','y','width','height','rx'))
            def test(x,y,left=left,top=top,width=width,height=height,rx=rx):
                if not left<=x<=left+width or not top<=y<=top+height:return False
                cx=min(max(x,left+rx),left+width-rx);cy=min(max(y,top+rx),top+height-rx)
                return (x-cx)**2+(y-cy)**2<=rx**2 if rx else True
        else:raise ValueError('unsupported SVG element: '+kind)
        result.append((test,rgb))
    return box[2],result


def rasterize(source,size,destination):
    extent,layers=shapes(source);samples=4;raw=bytearray()
    for row in range(size):
        raw.append(0)
        for col in range(size):
            totals=[0,0,0];covered=0
            for sy in range(samples):
                for sx in range(samples):
                    x=(col+(sx+.5)/samples)*extent/size;y=(row+(sy+.5)/samples)*extent/size;color=None
                    for test,rgb in layers:
                        if test(x,y):color=rgb
                    if color:
                        covered+=1
                        for k in range(3):totals[k]+=color[k]
            raw.extend([round(v/covered) if covered else 0 for v in totals]+[round(255*covered/samples**2)])
    def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw,9))+chunk(b'IEND',b'')
    destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(png)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source',type=Path,default=ROOT/'native-extension/brand-logo.svg');parser.add_argument('--small-source',type=Path,default=ROOT/'native-extension/brand-logo-small.svg');parser.add_argument('--output',type=Path,default=ROOT/'native-extension');args=parser.parse_args()
    for size in (16,32,48,128):rasterize(args.small_source if size<=32 else args.source,size,args.output/f'icon-{size}.png')
    # 中文注释：封闭影子层不能继承页面变量；生成模块与页面CSS共用同一份源，避免两套tokens漂移。
    css=(ROOT/'native-extension/brand.css').read_text();root=ET.parse(args.source).getroot();nodes=[(node.tag.split('}')[-1],node.attrib) for node in root]
    code='// 中文注释：由scripts/generate-brand.py生成；源为brand.css和显式SVG。\nexport const BRAND_CSS='+json.dumps(css,ensure_ascii=False)+';\n'
    code+='export function createBrandMark(doc){const make=name=>doc.createElementNS?doc.createElementNS("http://www.w3.org/2000/svg",name):doc.createElement(name);const svg=make("svg");svg.setAttribute("viewBox","0 0 32 32");svg.setAttribute("width","24");svg.setAttribute("height","24");svg.setAttribute("aria-hidden","true");svg.setAttribute("class","brand-mark");for(const [name,attrs] of '+json.dumps(nodes)+'){const el=make(name);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);svg.append(el);}return svg;}\n'
    (args.output/'brand.mjs').write_text(code)
    mono=ET.parse(args.source).getroot();mono.remove(mono[0]);ET.register_namespace('', 'http://www.w3.org/2000/svg')
    for node in mono:node.set('fill','#202733')
    (args.output/'brand-mark.svg').write_bytes(ET.tostring(mono,encoding='utf-8'))
    print('Generated four PNG sizes and shadow-layer brand module; no dependencies.')


if __name__=='__main__':main()
