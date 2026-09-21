'use client';
import * as Primitive from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import type { ReactNode } from 'react';
export function Modal({open,onOpenChange,title,description,children,wide=false}:{open:boolean;onOpenChange:(open:boolean)=>void;title:string;description:string;children:ReactNode;wide?:boolean}) {
  return <Primitive.Root open={open} onOpenChange={onOpenChange}><Primitive.Portal><Primitive.Overlay className="modal-overlay"/><Primitive.Content className={`modal ${wide?'modal-wide':''}`} aria-describedby="modal-description"><div className="modal-header"><div><Primitive.Title className="modal-title">{title}</Primitive.Title><Primitive.Description className="modal-description" id="modal-description">{description}</Primitive.Description></div><Primitive.Close className="icon-button" aria-label="關閉視窗"><X size={20}/></Primitive.Close></div>{children}</Primitive.Content></Primitive.Portal></Primitive.Root>;
}
