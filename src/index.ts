import { createBufferFromArray, createProgramInfo, createVAOFromBufferInfo, setUniforms, type ProgramInfo } from "twgl.js";

// Images
import myimage from "./logo/youtube.png";

// Shaders
import emptyFrag from "./shader/empty.frag";
import initVert from "./shader/init.vert";
import processVert from "./shader/process.vert";
import renderVert from "./shader/render.vert";
import renderFrag from "./shader/render.frag";

// Library
import { frames } from "./library/frames";
import { mouse } from "./library/mouse";
import { image } from "./library/image";
import { texture } from "./library/texture";
import { array } from "./library/array";

const shaders = {
  init: { vert: initVert, frag: emptyFrag },
  process: { vert: processVert, frag: emptyFrag },
  render: { vert: renderVert, frag: renderFrag },
};
  
const defaultParams = {
  attractionStrength: 80,
  maxSpeed: 1200,
  mouseRadius: 200,
  repulsionStrength: 1000,
  damping: .95,
};

type TFBuffer = { now: WebGLBuffer; move: WebGLBuffer; tf: WebGLTransformFeedback; };
type Dispose = () => void;

class WebglLogoParticle extends HTMLElement {
  static get observedAttributes() {
    return [
      'src',
      'attraction-strength',
      'max-speed',
      'mouse-radius',
      'repulsion-strength',
      'damping',
    ];
  }

  private canvas: HTMLCanvasElement;
  private gl?: WebGL2RenderingContext;
  private initProgram?: ProgramInfo;
  private processProgram?: ProgramInfo;
  private renderProgram?: ProgramInfo;
  private u_texture?: WebGLTexture;
  private buffers?: TFBuffer[];
  private vertexArrays: (WebGLVertexArrayObject | null)[] = [];
  private vertexArrays2: (WebGLVertexArrayObject | null)[] = [];
  private quie?: ReturnType<typeof quieCounter>;
  private pixels = 0;
  private resolution: readonly [number, number] = [0, 0];
  private frameDispose?: Dispose;
  private mouseDispose?: Dispose;

  constructor() {
    super();

    const shadow = this.attachShadow({ mode: 'open' });
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    shadow.appendChild(this.canvas);
  }

  connectedCallback() {
    if (!this.frameDispose) {
      this.initialize().catch(console.error);
    }
  }

  disconnectedCallback() {
    this.dispose();
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue === newValue) return;
    if (!this.isConnected) return;
    this.restart().catch(console.error);
  }

  private get src() {
    return this.getAttribute('src') || myimage;
  }

  private get attractionStrength() {
    return this.getNumberAttribute('attraction-strength', defaultParams.attractionStrength);
  }

  private get maxSpeed() {
    return this.getNumberAttribute('max-speed', defaultParams.maxSpeed);
  }

  private get mouseRadius() {
    return this.getNumberAttribute('mouse-radius', defaultParams.mouseRadius);
  }

  private get repulsionStrength() {
    return this.getNumberAttribute('repulsion-strength', defaultParams.repulsionStrength);
  }

  private get damping() {
    return this.getNumberAttribute('damping', defaultParams.damping);
  }

  private get options() {
    return {
      attractionStrength: this.attractionStrength,
      maxSpeed: this.maxSpeed,
      mouseRadius: this.mouseRadius,
      repulsionStrength: this.repulsionStrength,
      damping: this.damping,
    };
  }

  private getNumberAttribute(name: string, fallback: number) {
    const value = this.getAttribute(name);
    return value === null ? fallback : Number(value);
  }

  private async restart() {
    this.dispose();
    await this.initialize();
  }

  private async initialize() {
    const gl = this.canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    const tfOptions = {
      transformFeedbackVaryings: ["vNow", "vMove"],
      transformFeedbackMode: gl.SEPARATE_ATTRIBS,
    };

    this.initProgram = createProgramInfo(gl, [shaders.init.vert, shaders.init.frag], tfOptions);
    this.processProgram = createProgramInfo(gl, [shaders.process.vert, shaders.process.frag], tfOptions);
    this.renderProgram = createProgramInfo(gl, [shaders.render.vert, shaders.render.frag]);

    const source = await image(this.src);
    this.u_texture = texture(gl, source);
    this.buffers = createBuffers(gl, source);
    this.vertexArrays = createVAOs(gl, this.processProgram, this.buffers);
    this.vertexArrays2 = createVAOs(gl, this.renderProgram, this.buffers);
    this.quie = quieCounter(this.buffers.length);
    this.pixels = source.width * source.height;

    this.canvas.width = source.width;
    this.canvas.height = source.height;
    this.resolution = [source.width, source.height] as const;
    gl.viewport(0, 0, ...this.resolution);

    gl.useProgram(this.initProgram.program);
    setUniforms(this.initProgram, { u_texture: this.u_texture, resolution: this.resolution });

    gl.useProgram(this.processProgram.program);
    setUniforms(this.processProgram, { u_texture: this.u_texture, resolution: this.resolution });
    setUniforms(this.processProgram, this.options);

    gl.useProgram(this.renderProgram.program);
    setUniforms(this.renderProgram, { resolution: this.resolution });

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.disable(gl.DEPTH_TEST);

    this.runInit();

    this.mouseDispose = mouse(this.canvas, (...mouse) => {
      if (!this.processProgram) return;
      gl.useProgram(this.processProgram.program);
      setUniforms(this.processProgram, { mouse });
    });

    this.frameDispose = frames((delta, current) => {
      this.runProcess(delta, current);
      this.runRender();
    });
  }

  private dispose() {
    if (this.frameDispose) {
      this.frameDispose();
      this.frameDispose = undefined;
    }
    if (this.mouseDispose) {
      this.mouseDispose();
      this.mouseDispose = undefined;
    }
  }

  private runInit() {
    if (!this.gl || !this.initProgram || !this.buffers || !this.quie) return;

    this.gl.useProgram(this.initProgram.program);
    this.gl.enable(this.gl.RASTERIZER_DISCARD);
    this.gl.bindTransformFeedback(this.gl.TRANSFORM_FEEDBACK, this.buffers[this.quie.now].tf);
    this.gl.beginTransformFeedback(this.gl.POINTS);
    this.gl.drawArrays(this.gl.POINTS, 0, this.pixels);
    this.gl.endTransformFeedback();
    this.gl.bindTransformFeedback(this.gl.TRANSFORM_FEEDBACK, null);
    this.gl.disable(this.gl.RASTERIZER_DISCARD);
  }

  private runProcess(delta: number, current: number) {
    if (!this.gl || !this.processProgram || !this.buffers || !this.quie) return;
    const vao = this.vertexArrays[this.quie.now];
    if (!vao) return;

    this.gl.useProgram(this.processProgram.program);
    setUniforms(this.processProgram, { delta, current });
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
    this.gl.enable(this.gl.RASTERIZER_DISCARD);
    this.gl.bindTransformFeedback(this.gl.TRANSFORM_FEEDBACK, this.buffers[this.quie.next].tf);
    this.gl.beginTransformFeedback(this.gl.POINTS);
    this.gl.bindVertexArray(vao);
    this.gl.drawArrays(this.gl.POINTS, 0, this.pixels);
    this.gl.endTransformFeedback();
    this.gl.bindTransformFeedback(this.gl.TRANSFORM_FEEDBACK, null);
    this.gl.disable(this.gl.RASTERIZER_DISCARD);
    this.quie.tick();
  }

  private runRender() {
    if (!this.gl || !this.renderProgram || !this.quie) return;
    const vao = this.vertexArrays2[this.quie.now];
    if (!vao) return;

    this.gl.useProgram(this.renderProgram.program);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.bindVertexArray(vao);
    this.gl.drawArrays(this.gl.POINTS, 0, this.pixels);
  }
}

customElements.define('webgl-logo-particle', WebglLogoParticle);

function createBuffers(gl: WebGL2RenderingContext, image: ImageData, size = 2): TFBuffer[] {
  const buffer = new Float32Array(image.width * image.height * 2);

  return array(size, () => {
    const now = createBufferFromArray(gl, buffer, 'now');
    const move = createBufferFromArray(gl, buffer, 'move');
    const tf = gl.createTransformFeedback()!;

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, now);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, move);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

    return { now, move, tf } as TFBuffer;
  });
}

function createVAOs(gl: WebGL2RenderingContext, info: ProgramInfo, buffers: TFBuffer[]): (WebGLVertexArrayObject | null)[] {
  return buffers.map(buffer => {
    return createVAOFromBufferInfo(gl, info, {
      attribs: {
        now: { buffer: buffer.now, numComponents: 2, type: gl.FLOAT },
        move: { buffer: buffer.move, numComponents: 2, type: gl.FLOAT },
      }
    } as any);
  });
}

function quieCounter(size: number) {
  let now = 0;

  return {
    get now() {
      return now;
    },
    get next() {
      return (now + 1) % size;
    },
    tick() {
      now = this.next;
    }
  };
}
