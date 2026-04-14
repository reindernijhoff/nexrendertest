export interface VideoSegment {
    srcVideo: string;
    srcAudio: string | null;
    localVideo: string;
    localAudio: string | null;
    duration: number;
    overlapBefore: number;
    overlapAfter: number;
    zIndex: number;
    startTime: number;
    first?: string;
    firstDuration: number;
    middle: string;
    middleDuration: number;
    last?: string;
    lastDuration: number;
}

export interface AccelParams {
    decoder: string[];
    encoder: string;
    preset: string;
    extraParams: string[];
}
