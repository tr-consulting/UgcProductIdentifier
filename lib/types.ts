export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AzureSettings = {
  endpoint: string;
  deployment: string;
  apiKey: string;
};

export type ProductResult = {
  id: string;
  name: string;
  description: string;
  buyUrl: string;
  searchQuery?: string;
  imageDataUrl: string;
  purchased: boolean;
  comment: string;
};

export type CapturedFrame = {
  id: string;
  timestamp: number;
  bbox: BoundingBox;
  imageDataUrl: string;
  analysisImageDataUrl?: string;
  products: ProductResult[];
  analyzed: boolean;
};

export type Analyzer = {
  id: string;
  title: string;
  videoName: string;
  videoPreviewUrl?: string;
  frames: CapturedFrame[];
  createdAt: string;
};

export type AnalyzeApiResponse = {
  products: Array<{
    name: string;
    description: string;
    buyUrl: string;
    searchQuery?: string;
  }>;
};
