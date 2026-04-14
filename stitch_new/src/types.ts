export interface VideoSegment {
    srcVideo: string;
    srcAudio: string | null;
    localVideo: string;
    localAudio: string | null;
    duration: number;
    overlapBefore: number;
    overlapAfter: number;
    startTime: number;
    first?: string;
    middle: string;
    last?: string;
}

export interface AccelParams {
    decoder: string[];
    encoder: string;
    preset: string;
    extraParams: string[];
}
