export interface Position {
  x: number;
  y: number;
}

export interface Base {
  id: number;
  position: Position;
  isDestroyed: boolean;
  missileCount: number;
}

export interface Missile {
  id: number;
  start: Position;
  end: Position;
  current: Position;
  speed: number;
  angle: number;
}

export interface Explosion {
  id: number;
  center: Position;
  radius: number;
  maxRadius: number;
  isExpanding: boolean;
}
