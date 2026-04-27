export interface Building {
  id: string;
  territoryNumber?: string;
  buildingNumber: string;
  address: string;
  name?: string;
  mailbox?: 'Individual' | 'Coletiva';
  intercom?: 'Sim' | 'Não';
  blocks?: string;
  apartmentsCount?: string;
  apartments: string[];
  ownerId: string;
  visitCount?: number;
  lastVisitDate?: any;
  isCompleted?: boolean;
  facadeImageUrl?: string;
  underConstruction?: boolean;
  createdAt: any;
}

export interface Visit {
  id: string;
  buildingId: string;
  apartment: string;
  date: any;
  contacted: boolean;
  notes?: string;
  visitorId: string;
  visitorEmail: string;
}
